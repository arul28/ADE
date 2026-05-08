import React, { useState, useRef, useEffect, useCallback, useMemo } from "react";
import {
  type MissionIntervention,
  type OrchestratorChatThread,
  type OrchestratorChatMessage,
  type OrchestratorMetadata,
  type OrchestratorWorkerState,
  type OrchestratorChatTarget,
  type MissionStatus,
  type MissionRunView,
  type OrchestratorRunStatus,
} from "../../../shared/types";
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
import { ChatInput } from "./ChatInput";
import { ChatSurfaceShell } from "../chat/ChatSurfaceShell";
import { buildChatAppearanceRootStyle } from "../chat/chatAppearance";
import { useAppStore } from "../../state/appStore";
import { useMissionsStore } from "./useMissionsStore";
import { resolveWorkerThreadChannelStatus } from "./missionChatChannelModel";

const BG_PAGE = COLORS.pageBg;
const THREAD_MESSAGE_PAGE_SIZE = 100;

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

function formatMissionFeedMessageContent(title: string, detail: string): string {
  const trimmedTitle = title.trim();
  const trimmedDetail = detail.trim();
  if (!trimmedTitle.length) return trimmedDetail;
  if (!trimmedDetail.length) return `**${trimmedTitle}**`;
  return `**${trimmedTitle}**\n\n${trimmedDetail}`;
}

function workerThreadStatus(
  threadStatus: OrchestratorChatThread["status"],
  workerState: OrchestratorWorkerState | undefined,
  runStatus: OrchestratorRunStatus | null,
): Channel["status"] {
  return resolveWorkerThreadChannelStatus({ threadStatus, workerState, runStatus });
}

function orchestratorThreadStatus(
  threadStatus: OrchestratorChatThread["status"],
  runStatus: OrchestratorRunStatus | null,
): Channel["status"] {
  if (runStatus === "succeeded" || runStatus === "failed" || runStatus === "canceled") return "closed";
  return threadStatus;
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
  const [workerStates, setWorkerStates] = useState<OrchestratorWorkerState[]>([]);
  const [selectedChannelId, setSelectedChannelId] = useState("global");
  const [runActionBusy, setRunActionBusy] = useState<"pause" | "resume" | "cancel" | null>(null);
  const [completedCollapsed, setCompletedCollapsed] = useState(true);
  const [jumpNotice, setJumpNotice] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);

  const selectedChannelIdRef = useRef("global");
  const threadRefreshTimerRef = useRef<number | null>(null);
  const messageRefreshTimerRef = useRef<number | null>(null);
  const channelsRef = useRef<Channel[]>([]);
  const threadMessagesRef = useRef<OrchestratorChatMessage[]>([]);
  const latestThreadMessagesRequestRef = useRef(0);

  useEffect(() => { selectedChannelIdRef.current = selectedChannelId; }, [selectedChannelId]);
  useEffect(() => { threadMessagesRef.current = threadMessages; }, [threadMessages]);
  const workerStateByAttempt = useMemo(() => { const m = new Map<string, OrchestratorWorkerState>(); for (const s of workerStates) m.set(s.attemptId, s); return m; }, [workerStates]);

  // ── Build channel list from threads ──
  const channels = useMemo<Channel[]>(() => {
    const result: Channel[] = [{
      id: "global", kind: "global", label: "Mission Feed", fullLabel: "Mission Feed",
      threadId: null, sessionId: null, laneId: null, status: "active", stepKey: null, attemptId: null, unreadCount: 0, phaseLabel: null,
    }];
    const coordThread = threads.find((t) => t.threadType === "coordinator");
    if (coordThread) result.push({ id: `thread:${coordThread.id}`, kind: "orchestrator", label: "Orchestrator", fullLabel: "Orchestrator", threadId: coordThread.id, sessionId: coordThread.sessionId ?? null, laneId: coordThread.laneId ?? null, status: orchestratorThreadStatus(coordThread.status, runStatus), stepKey: null, attemptId: null, unreadCount: coordThread.unreadCount, phaseLabel: null });
    for (const t of threads.filter((t) => t.threadType === "teammate"))
      result.push({ id: `thread:${t.id}`, kind: "teammate", label: t.title || "Teammate", fullLabel: t.title || "Teammate", threadId: t.id, sessionId: t.sessionId ?? null, laneId: t.laneId ?? null, status: t.status, stepKey: t.stepKey ?? null, attemptId: t.attemptId ?? null, unreadCount: t.unreadCount, phaseLabel: null });
    for (const t of threads.filter((t) => t.threadType === "worker")) {
      const p = formatMissionWorkerPresentation({ title: t.title, stepKey: t.stepKey ?? null });
      result.push({ id: `thread:${t.id}`, kind: "worker", label: p.label, fullLabel: p.fullLabel, threadId: t.id, sessionId: t.sessionId ?? null, laneId: t.laneId ?? null, status: workerThreadStatus(t.status, t.attemptId ? workerStateByAttempt.get(t.attemptId) : undefined, runStatus), stepKey: t.stepKey ?? null, attemptId: t.attemptId ?? null, unreadCount: t.unreadCount, phaseLabel: p.phaseLabel });
    }
    return result;
  }, [runStatus, threads, workerStateByAttempt]);

  const teammateChannels = useMemo(() => channels.filter((c) => c.kind === "teammate"), [channels]);
  const activeWorkerChannels = useMemo(() => channels.filter((c) => c.kind === "worker" && c.status === "active"), [channels]);
  const completedWorkerChannels = useMemo(() => channels.filter((c) => c.kind === "worker" && c.status !== "active"), [channels]);
  const orchestratorChannel = useMemo(() => channels.find((c) => c.kind === "orchestrator") ?? null, [channels]);
  const selectedChannel = useMemo(() => channels.find((c) => c.id === selectedChannelId) ?? channels[0], [channels, selectedChannelId]);
  const missionSurfaceMode = selectedChannel?.kind === "global" ? "mission-feed" : "mission-thread";
  const missionSurfaceAccent = useMemo(() => resolveMissionSurfaceAccent(selectedChannel), [selectedChannel]);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  const chatChromeTint = useAppStore((s) => s.chatChromeTint);
  const chatShellGeometry = useAppStore((s) => s.chatShellGeometry);
  const chatAppearanceRootStyle = useMemo(
    () => buildChatAppearanceRootStyle({ chatFontSizePx, transcriptDensity: chatTranscriptDensity }),
    [chatFontSizePx, chatTranscriptDensity],
  );

  useEffect(() => { channelsRef.current = channels; }, [channels]);

  const workerStatusDotFn = useCallback((attemptId: string | null) => attemptId ? statusDotForWorker(workerStateByAttempt.get(attemptId)?.state) : COLORS.success, [workerStateByAttempt]);

  // ── Data fetching ──
  const refreshThreads = useCallback(async () => { try { setThreads(await window.ade.orchestrator.listChatThreads({ missionId, includeClosed: true })); } catch { /* ignore */ } }, [missionId]);
  const refreshThreadMessages = useCallback(async (
    threadId?: string | null,
    mode: "replace" | "append-older" = "replace",
  ) => {
    if (!threadId) {
      setThreadMessages([]);
      return;
    }
    const requestId = latestThreadMessagesRequestRef.current + 1;
    latestThreadMessagesRequestRef.current = requestId;
    const before = mode === "append-older" ? threadMessagesRef.current[0]?.timestamp ?? null : null;
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
    } catch (error) {
      if (latestThreadMessagesRequestRef.current !== requestId) return;
      console.warn("[MissionChatV2] failed to refresh mission thread messages", error);
    }
  }, [missionId]);
  const refreshWorkers = useCallback(async () => {
    try {
      setWorkerStates(runId ? await window.ade.orchestrator.getWorkerStates({ runId }) : []);
    } catch {
      /* ignore */
    }
  }, [runId]);
  const refreshSelectedMessages = useCallback(async () => {
    if (!selectedChannel) return;
    if (selectedChannel.kind === "global") return;
    await refreshThreadMessages(selectedChannel.threadId);
  }, [refreshThreadMessages, selectedChannel]);

  useEffect(() => {
    latestThreadMessagesRequestRef.current += 1;
    setThreads([]);
    setThreadMessages([]);
    setWorkerStates([]);
    setSelectedChannelId("global");
    setRunActionBusy(null);
    setCompletedCollapsed(true);
    setJumpNotice(null);
    setInput("");
    setSending(false);
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
        content: formatMissionFeedMessageContent(item.title, item.detail),
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

  const missionNarrative = useMemo(() => buildMissionStateNarrative(runView), [runView]);

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

  const handleAppendMentionTarget = useCallback((targetId: string) => {
    setInput((current) => {
      const prefix = current.trim().length > 0 && !/\s$/.test(current) ? `${current} ` : current;
      return `${prefix}@${targetId} `;
    });
  }, []);

  const handleSendMessage = useCallback(async (message: string) => {
    const content = message.trim();
    if (!content || !selectedChannel || selectedChannel.kind === "global" || !selectedChannel.threadId || chatBlocked) return;
    setSending(true);
    setJumpNotice(null);
    try {
      await window.ade.orchestrator.sendThreadMessage({
        missionId,
        threadId: selectedChannel.threadId,
        content,
      });
      setInput("");
      await Promise.all([
        refreshThreads(),
        refreshThreadMessages(selectedChannel.threadId),
      ]);
    } catch (error) {
      setJumpNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }, [chatBlocked, missionId, refreshThreadMessages, refreshThreads, selectedChannel]);

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

  const fallbackFooterHint = useMemo(() => {
    if (selectedChannel?.kind === "global") {
      return "Mission feed is read-only. Open the orchestrator or a worker thread to send a message.";
    }
    if (chatBlocked) {
      return `${chatBlocked.reason} ${chatBlocked.action}`;
    }
    if (selectedChannel?.kind === "orchestrator") {
      return "Coordinator history is read-only until ADE attaches a live orchestrator session.";
    }
    if (selectedChannel?.kind === "worker") {
      return selectedChannel.status === "active"
        ? "Worker history is read-only until ADE attaches the live worker session."
        : "Completed worker history is read-only.";
    }
    return "Mission thread history is read-only.";
  }, [chatBlocked, selectedChannel?.kind, selectedChannel?.status]);

  return (
    <div className="flex h-full min-h-0 min-w-0 max-w-full overflow-hidden">
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
      <div className="flex min-w-0 max-w-full flex-1 flex-col overflow-hidden" style={{ background: BG_PAGE }}>
        <div
          data-chat-appearance-root
          style={chatAppearanceRootStyle}
          className="m-2 min-h-0 min-w-0 max-w-full flex-1 overflow-hidden"
        >
          <ChatSurfaceShell
            mode={missionSurfaceMode}
            accentColor={missionSurfaceAccent}
            chromeTint={chatChromeTint}
            shellGeometry={chatShellGeometry}
            contentScale={1}
            className="w-full min-w-0 max-w-full rounded-[var(--chat-radius-shell)]"
            bodyClassName="flex min-h-0 min-w-0 flex-1 flex-col"
            footer={selectedChannel?.kind !== "global" && !chatBlocked ? (
              <ChatInput
                selectedChannel={selectedChannel}
                input={input}
                attachments={[]}
                sending={sending}
                chatBlocked={Boolean(chatBlocked)}
                participants={[]}
                quickTargets={[]}
                onInputChange={setInput}
                onSend={handleSendMessage}
                onAppendMentionTarget={handleAppendMentionTarget}
              />
            ) : (
              <div
                className="w-full min-w-0 max-w-full overflow-hidden px-4 py-3 text-[11px]"
                style={{
                  borderTop: `1px solid rgba(255,255,255,0.08)`,
                  background: "linear-gradient(180deg, rgba(20,16,29,0.96) 0%, rgba(13,10,20,0.92) 100%)",
                  color: COLORS.textSecondary,
                  fontFamily: MONO_FONT,
                }}
              >
                {fallbackFooterHint}
              </div>
            )}
          >
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
              missionNarrative={missionNarrative}
              runControls={runControls}
              onApproval={handleApproval}
            />
          </ChatSurfaceShell>
        </div>
      </div>
    </div>
  );
});
