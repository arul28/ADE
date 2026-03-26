import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "@phosphor-icons/react";
import {
  createDefaultComputerUsePolicy,
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatExecutionMode,
  type AgentChatEventEnvelope,
  type AgentChatFileRef,
  type AgentChatSessionProfile,
  type ChatSurfaceChip,
  type ChatSurfacePresentation,
  type AgentChatSessionSummary,
  type ComputerUseOwnerSnapshot,
  type ComputerUsePolicy,
} from "../../../shared/types";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  isModelProviderGroup,
  MODEL_REGISTRY,
  resolveModelDescriptorForProvider,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { cn } from "../ui/cn";
import { AgentChatComposer } from "./AgentChatComposer";
import { AgentChatMessageList } from "./AgentChatMessageList";
import { AgentQuestionModal } from "./AgentQuestionModal";
import { ToolLogo } from "../terminals/ToolLogos";
import { ChatSurfaceShell } from "./ChatSurfaceShell";
import { chatChipToneClass } from "./chatSurfaceTheme";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";
import { ChatContextMeter } from "./ChatContextMeter";
import { deriveChatSubagentSnapshots } from "./chatExecutionSummary";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { useClickOutside } from "../../hooks/useClickOutside";

// Hooks
import { useAgentChatEvents } from "./hooks/useAgentChatEvents";
import {
  useAgentChatSessions,
  resolveNextSelectedSessionId,
} from "./hooks/useAgentChatSessions";
import {
  useAgentChatComposerState,
  summarizeNativeControls,
  readLastUsedModelId,
  writeLastUsedModelId,
  readLastUsedReasoningEffort,
  writeLastUsedReasoningEffort,
  selectReasoningEffort,
  type NativeControlState,
} from "./hooks/useAgentChatComposerState";

const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;

export function shouldPromoteSessionForComputerUse(
  session: Pick<AgentChatSessionSummary, "sessionProfile"> | null | undefined,
  _computerUsePolicy: ComputerUsePolicy,
): boolean {
  return session?.sessionProfile !== "workflow";
}

// Re-export for tests
export { resolveNextSelectedSessionId };

type ExecutionModeOption = {
  value: AgentChatExecutionMode;
  label: string;
  summary: string;
  helper: string;
  accent: string;
};

function getExecutionModeOptions(model: ModelDescriptor | null | undefined): ExecutionModeOption[] {
  if (!model?.isCliWrapped) return [];
  if (model.family === "openai") {
    return [
      {
        value: "focused",
        label: "Focused",
        summary: "Single thread",
        helper: "Keep the turn in one thread unless the task clearly benefits from delegation.",
        accent: "#38BDF8",
      },
      {
        value: "parallel",
        label: "Parallel",
        summary: "Parallel delegates",
        helper: "Tell Codex to split independent work into parallel delegates and reconcile the result in one thread.",
        accent: "#10B981",
      },
    ];
  }
  return [];
}

function chatToolTypeForProvider(provider: string | null | undefined): "codex-chat" | "claude-chat" | "ai-chat" {
  switch (provider) {
    case "codex": return "codex-chat";
    case "claude": return "claude-chat";
    default: return "ai-chat";
  }
}

function normalizeChatLabel(raw: string | null | undefined): string | null {
  const normalized = String(raw ?? "").replace(/\s+/g, " ").trim();
  return normalized.length ? normalized : null;
}

function stripOutcomePrefix(raw: string): string {
  const stripped = raw.replace(/^(completed?|done|finished|resolved|success|interrupted|failed|error)\b[\s:.-]*/iu, "").trim();
  return stripped.length ? stripped : raw;
}

function isLowSignalChatLabel(raw: string | null | undefined): boolean {
  const normalized = normalizeChatLabel(raw);
  if (!normalized) return false;

  const collapsed = normalized
    .replace(/\p{Extended_Pictographic}/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();

  if (!collapsed.length) return true;
  if (/\b(error|exception|apicall|traceback|stack\s*trace)\b/i.test(collapsed)) return true;

  if (/^(session closed|chat completed)\b/u.test(collapsed)) {
    return true;
  }

  if (/^(completed?|done|finished|resolved|success)\b/u.test(collapsed)) {
    const remainder = collapsed.replace(/^(completed?|done|finished|resolved|success)\b/u, "").trim();
    const remainderTokens = remainder.length ? remainder.split(/\s+/).filter(Boolean) : [];
    const genericRemainder = remainderTokens.every((token: string) =>
      /^(ok|okay|ready|hello|hi|test|yes|no|true|false|response|reply|result|output|pass|passed)$/u.test(token)
    );
    return !remainderTokens.length || remainderTokens.length <= 2 || genericRemainder;
  }

  return false;
}

function preferredChatLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeChatLabel(raw);
  if (!normalized || isLowSignalChatLabel(normalized)) return null;
  return stripOutcomePrefix(normalized);
}

function chatSessionTitle(session: AgentChatSessionSummary): string {
  const explicitTitle = preferredChatLabel(session.title);
  if (explicitTitle) return explicitTitle;

  const explicitGoal = preferredChatLabel(session.goal);
  if (explicitGoal) return explicitGoal;

  const completionSummary = preferredChatLabel(session.completion?.summary);
  if (completionSummary) return completionSummary;

  const summary = preferredChatLabel(session.summary);
  if (summary) return summary;

  const descriptor = session.modelId ? getModelById(session.modelId) : null;
  return descriptor?.displayName ?? `${session.provider}/${session.model}`;
}

function completionBadgeClass(status: NonNullable<AgentChatSessionSummary["completion"]>["status"]): string {
  switch (status) {
    case "completed": return "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300";
    case "blocked": return "border-red-400/20 bg-red-400/[0.08] text-red-300";
    default: return "border-amber-400/20 bg-amber-400/[0.08] text-amber-300";
  }
}

function resolveAssistantLabel(
  model: ModelDescriptor | null | undefined,
  sessionProvider: string | null | undefined,
): string {
  if (model?.family === "anthropic" || model?.cliCommand === "claude") return "Claude";
  if (model?.family === "openai" || model?.cliCommand === "codex") return "Codex";
  if (sessionProvider === "claude") return "Claude";
  if (sessionProvider === "codex") return "Codex";
  return "Assistant";
}

export function AgentChatPane({
  laneId,
  laneLabel,
  initialSessionId,
  initialSessionSummary,
  lockSessionId,
  hideSessionTabs = false,
  forceNewSession = false,
  forceDraftMode = false,
  availableModelIdsOverride,
  modelSelectionLocked = false,
  permissionModeLocked = false,
  presentation,
  onSessionCreated,
}: {
  laneId: string | null;
  laneLabel?: string | null;
  initialSessionId?: string | null;
  initialSessionSummary?: AgentChatSessionSummary | null;
  lockSessionId?: string | null;
  hideSessionTabs?: boolean;
  forceNewSession?: boolean;
  forceDraftMode?: boolean;
  availableModelIdsOverride?: string[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
  presentation?: ChatSurfacePresentation;
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}) {
  const lockedSingleSessionMode = Boolean(lockSessionId && hideSessionTabs && initialSessionSummary);
  const forceDraft = forceDraftMode || forceNewSession;
  const surfaceProfile = presentation?.profile ?? "standard";
  const isPersistentIdentitySurface = surfaceProfile === "persistent_identity";
  const modelSwitchPolicy = presentation?.modelSwitchPolicy ?? "same-family-after-launch";
  const surfaceMode = presentation?.mode ?? "standard";

  // ── Events hook ───────────────────────────────────────────────────
  const eventsHook = useAgentChatEvents({ selectedSessionId: null });

  // ── Sessions hook ─────────────────────────────────────────────────
  const sessionsHook = useAgentChatSessions({
    laneId,
    lockSessionId,
    initialSessionId,
    initialSessionSummary,
    forceNewSession,
    forceDraftMode,
    lockedSingleSessionMode,
    eventsBySessionRef: eventsHook.eventsBySessionRef,
    setEventsBySession: eventsHook.setEventsBySession,
    setTurnActiveBySession: eventsHook.setTurnActiveBySession,
    setPendingInputsBySession: eventsHook.setPendingInputsBySession,
  });

  const {
    sessions,
    setSessions,
    selectedSessionId,
    setSelectedSessionId,
    selectedSession,
    selectedSessionModelId,
    refreshSessions,
    loadHistory,
    optimisticSessionIdsRef,
    pendingSelectedSessionIdRef,
    draftSelectionLockedRef,
    knownSessionIdsRef,
    loadedHistoryRef,
    scheduleSessionsRefresh,
  } = sessionsHook;

  // ── Derive events for real selectedSessionId ──────────────────────
  const selectedEvents = selectedSessionId ? eventsHook.eventsBySession[selectedSessionId] ?? [] : [];
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  const turnActive = selectedSessionId ? (eventsHook.turnActiveBySession[selectedSessionId] ?? false) : false;
  const pendingInput = selectedSessionId ? (eventsHook.pendingInputsBySession[selectedSessionId]?.[0] ?? null) : null;

  const {
    flushQueuedEvents,
    scheduleQueuedEventFlush,
    eventsBySessionRef,
    pendingEventQueueRef,
    eventFlushTimerRef,
    setEventsBySession,
    setPendingInputsBySession,
  } = eventsHook;

  // ── Composer state hook ───────────────────────────────────────────
  const composerHook = useAgentChatComposerState({
    surfaceProfile,
    selectedSession,
    selectedSessionId,
    selectedSessionModelId,
    selectedEvents,
    laneId,
    availableModelIdsOverride,
  });

  const {
    modelId, setModelId,
    reasoningEffort, setReasoningEffort,
    executionMode, setExecutionMode,
    claudePermissionMode, setClaudePermissionMode,
    codexApprovalPolicy, setCodexApprovalPolicy,
    codexSandbox, setCodexSandbox,
    codexConfigSource, setCodexConfigSource,
    unifiedPermissionMode, setUnifiedPermissionMode,
    computerUsePolicy, setComputerUsePolicy,
    attachments, setAttachments,
    draft, setDraft, clearDraft,
    includeProjectDocs, setIncludeProjectDocs,
    sendOnEnter, setSendOnEnter,
    sdkSlashCommands, setSdkSlashCommands,
    promptSuggestion, setPromptSuggestion,
    availableModelIds,
    providerConnections,
    preferencesReady, setPreferencesReady,
    currentNativeControls,
    syncComposerToSession,
    refreshAvailableModels,
    refreshProviderConnections,
    buildNativeControlPayload,
  } = composerHook;

  // ── Remaining local state ─────────────────────────────────────────
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [computerUseSnapshot, setComputerUseSnapshot] = useState<ComputerUseOwnerSnapshot | null>(null);
  const [proofDrawerOpen, setProofDrawerOpen] = useState(false);
  const [sessionDelta, setSessionDelta] = useState<{ insertions: number; deletions: number } | null>(null);
  const [sessionMutationKind, setSessionMutationKind] = useState<"model" | "permission" | "computer-use" | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffModelId, setHandoffModelId] = useState("");

  const submitInFlightRef = useRef(false);
  const createSessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const computerUseSnapshotInFlightRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const lastComputerUseSnapshotRef = useRef<{ sessionId: string; fetchedAt: number } | null>(null);
  const handoffRef = useRef<HTMLDivElement | null>(null);

  // ── Derived values ────────────────────────────────────────────────
  const laneDisplayLabel = useMemo(() => {
    const normalized = laneLabel?.trim();
    return normalized?.length ? normalized : laneId;
  }, [laneId, laneLabel]);

  const activeProviderConnection = (() => {
    if (selectedSession?.provider === "claude") return providerConnections?.claude ?? null;
    if (selectedSession?.provider === "codex") return providerConnections?.codex ?? null;
    return null;
  })();

  const selectedModelDesc = getModelById(modelId);
  const reasoningTiers = selectedModelDesc?.reasoningTiers ?? [];
  const identitySessionSettingsBusy = isPersistentIdentitySurface && sessionMutationKind !== null;
  const modelSelectionDiffersFromSession = Boolean(selectedSession && selectedSessionModelId && selectedSessionModelId !== modelId);

  const sessionProvider = useMemo(() => {
    if (selectedSession && !modelSelectionDiffersFromSession) return selectedSession.provider;
    const desc = getModelById(modelId);
    if (!desc) return "unified";
    if (desc.family === "openai" && desc.isCliWrapped) return "codex";
    if (desc.family === "anthropic" && desc.isCliWrapped) return "claude";
    return "unified";
  }, [selectedSession, modelSelectionDiffersFromSession, modelId]);

  const executionModeOptions = useMemo(() => getExecutionModeOptions(selectedModelDesc), [selectedModelDesc]);
  const selectedExecutionMode = useMemo(
    () => executionModeOptions.find((option) => option.value === executionMode) ?? executionModeOptions[0] ?? null,
    [executionMode, executionModeOptions],
  );
  const hasComputerUseSelectionChanged = useMemo(() => {
    const sessionPolicy = selectedSession?.computerUse ?? createDefaultComputerUsePolicy();
    return JSON.stringify(sessionPolicy) !== JSON.stringify(computerUsePolicy);
  }, [computerUsePolicy, selectedSession?.computerUse]);
  const launchModeEditable = !selectedSessionId || selectedEvents.length === 0;
  const resolvedTitle = presentation?.title?.trim()
    || (surfaceMode === "resolver" ? "AI Resolver" : laneDisplayLabel?.trim() || "Chat");
  const assistantLabel = presentation?.assistantLabel?.trim()
    || resolveAssistantLabel(selectedModelDesc, selectedSession?.provider);
  const messagePlaceholder = presentation?.messagePlaceholder?.trim()
    || (assistantLabel === "Assistant" ? "Message the assistant..." : `Message ${assistantLabel}...`);
  const chipsJson = JSON.stringify(presentation?.chips ?? []);
  const resolvedChips = useMemo(() => JSON.parse(chipsJson) as ChatSurfaceChip[], [chipsJson]);

  const effectiveAvailableModelIds = useMemo(() => {
    return filterChatModelIdsForSession({
      availableModelIds: availableModelIdsOverride?.length ? availableModelIdsOverride : availableModelIds,
      activeSessionModelId: selectedSessionModelId,
      hasConversation: selectedEvents.length > 0,
      policy: modelSwitchPolicy,
    });
  }, [availableModelIds, availableModelIdsOverride, modelSwitchPolicy, selectedSessionModelId, selectedEvents.length]);
  const handoffAvailableModelIds = useMemo(() => {
    const merged = new Set<string>(availableModelIdsOverride?.length ? availableModelIdsOverride : availableModelIds);
    if (selectedSessionModelId) merged.add(selectedSessionModelId);
    return MODEL_REGISTRY.filter((model) => !model.deprecated && merged.has(model.id)).map((model) => model.id);
  }, [availableModelIds, availableModelIdsOverride, selectedSessionModelId]);
  const canShowHandoff = Boolean(
    lockSessionId && selectedSessionId && selectedSession
      && handoffAvailableModelIds.length > 0 && surfaceMode === "standard"
      && !isPersistentIdentitySurface && (selectedSession.surface ?? "work") === "work",
  );
  const handoffBlocked = turnActive || Boolean(pendingInput) || handoffBusy;
  const handoffButtonTitle = handoffBlocked
    ? "Wait for the current output or approval to finish before handing off this chat."
    : "Create a new work chat on another model and seed it with a summary of this chat.";

  // ── Callbacks ─────────────────────────────────────────────────────

  const refreshComputerUseSnapshot = useCallback(async (
    sessionId: string | null,
    options?: { force?: boolean },
  ) => {
    if (!sessionId) {
      computerUseSnapshotInFlightRef.current = null;
      lastComputerUseSnapshotRef.current = null;
      setComputerUseSnapshot(null);
      return;
    }
    if (!options?.force) {
      const inFlight = computerUseSnapshotInFlightRef.current;
      if (inFlight?.sessionId === sessionId) return inFlight.promise;
      const previous = lastComputerUseSnapshotRef.current;
      if (previous?.sessionId === sessionId && Date.now() - previous.fetchedAt < COMPUTER_USE_SNAPSHOT_COOLDOWN_MS) return;
    }
    let request: Promise<void> | null = null;
    request = (async () => {
      try {
        const snapshot = await window.ade.computerUse.getOwnerSnapshot({ owner: { kind: "chat_session", id: sessionId } });
        lastComputerUseSnapshotRef.current = { sessionId, fetchedAt: Date.now() };
        if (selectedSessionIdRef.current === sessionId) setComputerUseSnapshot(snapshot);
      } catch {
        if (selectedSessionIdRef.current === sessionId) setComputerUseSnapshot(null);
      } finally {
        if (request && computerUseSnapshotInFlightRef.current?.promise === request) computerUseSnapshotInFlightRef.current = null;
      }
    })();
    computerUseSnapshotInFlightRef.current = { sessionId, promise: request };
    try { await request; } catch { /* Errors reflected by clearing visible snapshot */ }
  }, []);

  const patchSessionSummary = useCallback((sessionId: string, patch: Partial<AgentChatSessionSummary>) => {
    setSessions((prev) => prev.map((session) => (session.sessionId === sessionId ? { ...session, ...patch } : session)));
  }, [setSessions]);

  const createSession = useCallback(async (): Promise<string | null> => {
    if (createSessionPromiseRef.current) return createSessionPromiseRef.current;
    if (!laneId) return null;
    const createPromise = (async () => {
      const desc = getModelById(modelId);
      const provider = desc?.isCliWrapped ? (desc.family === "openai" ? "codex" : "claude") : "unified";
      const model = desc ? getRuntimeModelRefForDescriptor(desc, provider) : modelId;
      const sessionProfile: AgentChatSessionProfile = "workflow";
      const created = await window.ade.agentChat.create({
        laneId, provider, model, modelId, sessionProfile, reasoningEffort,
        ...buildNativeControlPayload(provider),
        computerUse: computerUsePolicy,
      });
      loadedHistoryRef.current.delete(created.id);
      optimisticSessionIdsRef.current.add(created.id);
      pendingSelectedSessionIdRef.current = created.id;
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(created.id);
      await onSessionCreated?.(created.id);
      void refreshSessions().catch(() => {});
      return created.id;
    })();
    createSessionPromiseRef.current = createPromise;
    try { return await createPromise; } finally {
      if (createSessionPromiseRef.current === createPromise) createSessionPromiseRef.current = null;
    }
  }, [buildNativeControlPayload, computerUsePolicy, draftSelectionLockedRef, laneId, loadedHistoryRef, modelId, onSessionCreated, optimisticSessionIdsRef, pendingSelectedSessionIdRef, reasoningEffort, refreshSessions, setSelectedSessionId]);

  const handoffSession = useCallback(async () => {
    if (!canShowHandoff || !selectedSessionId || !handoffModelId || handoffBlocked) return;
    setError(null);
    setHandoffBusy(true);
    try {
      const result = await window.ade.agentChat.handoff({ sourceSessionId: selectedSessionId, targetModelId: handoffModelId });
      setHandoffOpen(false);
      await onSessionCreated?.(result.session.id);
      void refreshSessions().catch(() => {});
    } catch (handoffError) {
      setError(handoffError instanceof Error ? handoffError.message : String(handoffError));
    } finally { setHandoffBusy(false); }
  }, [canShowHandoff, handoffBlocked, handoffModelId, onSessionCreated, refreshSessions, selectedSessionId]);

  const searchAttachments = useCallback(async (query: string): Promise<AgentChatFileRef[]> => {
    if (!laneId) return [];
    const trimmed = query.trim();
    if (!trimmed.length) return [];
    if (selectedSessionId && sessionProvider === "codex") {
      try {
        const codexHits = await window.ade.agentChat.fileSearch({ sessionId: selectedSessionId, query: trimmed });
        if (codexHits.length > 0) return codexHits.map((hit) => ({ path: hit.path, type: inferAttachmentType(hit.path) }));
      } catch { /* Fall through */ }
    }
    const hits = await window.ade.files.quickOpen({ workspaceId: laneId, query: trimmed, limit: 60 });
    return hits.map((hit) => ({ path: hit.path, type: inferAttachmentType(hit.path) }));
  }, [laneId, selectedSessionId, sessionProvider]);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    setAttachments((prev) => { if (prev.some((e) => e.path === attachment.path)) return prev; return [...prev, attachment]; });
  }, [setAttachments]);

  const removeAttachment = useCallback((attachmentPath: string) => {
    setAttachments((prev) => prev.filter((e) => e.path !== attachmentPath));
  }, [setAttachments]);

  const updateNativeControls = useCallback(async (patch: Partial<NativeControlState>) => {
    if (isPersistentIdentitySurface && sessionMutationKind) return;
    const nextControls: NativeControlState = { ...currentNativeControls, ...patch };
    setClaudePermissionMode(nextControls.claudePermissionMode);
    setCodexApprovalPolicy(nextControls.codexApprovalPolicy);
    setCodexSandbox(nextControls.codexSandbox);
    setCodexConfigSource(nextControls.codexConfigSource);
    setUnifiedPermissionMode(nextControls.unifiedPermissionMode);
    if (!selectedSessionId) return;
    const provider = selectedSession?.provider ?? sessionProvider;
    const nextSummary = summarizeNativeControls(provider, nextControls);
    patchSessionSummary(selectedSessionId, nextSummary);
    if (isPersistentIdentitySurface) setSessionMutationKind("permission");
    try {
      await window.ade.agentChat.updateSession({ sessionId: selectedSessionId, ...nextSummary });
      void refreshSessions().catch(() => {});
    } catch (err) {
      void refreshSessions().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
    } finally { if (isPersistentIdentitySurface) setSessionMutationKind(null); }
  }, [currentNativeControls, isPersistentIdentitySurface, patchSessionSummary, refreshSessions, selectedSession, selectedSessionId, sessionMutationKind, sessionProvider, setClaudePermissionMode, setCodexApprovalPolicy, setCodexSandbox, setCodexConfigSource, setUnifiedPermissionMode]);

  const handleComputerUsePolicyChange = useCallback(async (nextPolicy: ComputerUsePolicy) => {
    if (isPersistentIdentitySurface && sessionMutationKind) return;
    setComputerUsePolicy(nextPolicy);
    if (!selectedSessionId) return;
    patchSessionSummary(selectedSessionId, { computerUse: nextPolicy });
    if (isPersistentIdentitySurface) setSessionMutationKind("computer-use");
    try {
      await window.ade.agentChat.updateSession({ sessionId: selectedSessionId, computerUse: nextPolicy });
      await refreshSessions();
      await refreshComputerUseSnapshot(selectedSessionId, { force: true });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { if (isPersistentIdentitySurface) setSessionMutationKind(null); }
  }, [isPersistentIdentitySurface, patchSessionSummary, refreshComputerUseSnapshot, refreshSessions, selectedSessionId, sessionMutationKind, setComputerUsePolicy]);

  const submit = useCallback(async () => {
    if (submitInFlightRef.current || busy) return;
    if (!modelId) return;
    const text = draft.trim();
    if (!text.length || !laneId) return;
    const draftSnapshot = draft;
    const attachmentsSnapshot = attachments;
    const isLiteralSlashCommand = text.startsWith("/");
    submitInFlightRef.current = true;
    setBusy(true);
    setError(null);
    clearDraft();
    setAttachments([]);
    try {
      let finalText = text;
      if (!isLiteralSlashCommand && includeProjectDocs) {
        const docPaths = [".ade/context/PRD.ade.md", ".ade/context/ARCHITECTURE.ade.md"];
        const docNote = ["[Project Context — generated from main branch, may not reflect in-progress lane work]", "The following project-level docs are available for reference. Read them with read_file if you need project context:", ...docPaths.map((p) => `- ${p}`)].join("\n");
        finalText = `${docNote}\n\n---\n\n${finalText}`;
        setIncludeProjectDocs(false);
      }
      let sessionId = selectedSessionId;
      const shouldPromoteLightSession = shouldPromoteSessionForComputerUse(selectedSession, computerUsePolicy);
      const selectedModelChanged = Boolean(selectedSessionId) && Boolean(selectedSessionModelId) && selectedSessionModelId !== modelId;
      if (sessionId && !turnActive && (selectedModelChanged || hasComputerUseSelectionChanged || shouldPromoteLightSession)) {
        const desc = getModelById(modelId);
        const provider = desc?.isCliWrapped ? (desc.family === "openai" ? "codex" : "claude") : "unified";
        await window.ade.agentChat.updateSession({ sessionId, modelId, reasoningEffort, ...buildNativeControlPayload(provider), computerUse: computerUsePolicy });
        await refreshSessions();
      } else if (!sessionId) {
        sessionId = await createSession();
      }
      if (!sessionId) throw new Error("Unable to create chat session.");
      const selectedAttachments = isLiteralSlashCommand ? [] : attachmentsSnapshot;
      if (eventsHook.turnActiveBySession[sessionId]) {
        const steerText = selectedAttachments.length ? `${finalText}\n\nAttached context:\n${selectedAttachments.map((e) => `- ${e.type}: ${e.path}`).join("\n")}` : finalText;
        await window.ade.agentChat.steer({ sessionId, text: steerText });
      } else {
        await window.ade.agentChat.send({ sessionId, text: finalText, displayText: text, attachments: selectedAttachments, reasoningEffort, executionMode: launchModeEditable ? executionMode : null });
      }
      await refreshSessions().catch(() => {});
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setDraft(draftSnapshot);
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setError(message);
      if (/ade chat could not authenticate/i.test(message) || /not authenticated/i.test(message) || /login required/i.test(message)) {
        void refreshAvailableModels().catch(() => {});
      }
    } finally { submitInFlightRef.current = false; setBusy(false); }
  }, [attachments, buildNativeControlPayload, busy, createSession, computerUsePolicy, draft, executionMode, hasComputerUseSelectionChanged, includeProjectDocs, laneId, launchModeEditable, modelId, reasoningEffort, refreshSessions, selectedEvents.length, selectedSessionId, selectedSessionModelId, turnActive, eventsHook.turnActiveBySession, refreshAvailableModels, selectedSession, setAttachments, setDraft, setIncludeProjectDocs]);

  const interrupt = useCallback(async () => {
    if (!selectedSessionId) return;
    try { await window.ade.agentChat.interrupt({ sessionId: selectedSessionId }); }
    catch (interruptError) { setError(interruptError instanceof Error ? interruptError.message : String(interruptError)); }
  }, [selectedSessionId]);

  const approve = useCallback(async (decision: AgentChatApprovalDecision, responseText?: string | null, answers?: Record<string, string | string[]>) => {
    if (!selectedSessionId) return;
    const request = eventsHook.pendingInputsBySession[selectedSessionId]?.[0];
    if (!request) return;
    try {
      await window.ade.agentChat.respondToInput({ sessionId: selectedSessionId, itemId: request.itemId, decision, responseText, ...(answers ? { answers } : {}) });
      setPendingInputsBySession((prev) => ({ ...prev, [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((e) => e.itemId !== request.itemId) }));
    } catch (approvalError) { setError(approvalError instanceof Error ? approvalError.message : String(approvalError)); }
  }, [eventsHook.pendingInputsBySession, selectedSessionId, setPendingInputsBySession]);

  // ── Effects ───────────────────────────────────────────────────────

  useEffect(() => { selectedSessionIdRef.current = selectedSessionId; }, [selectedSessionId]);

  useEffect(() => { syncComposerToSession(selectedSession); }, [selectedSession?.sessionId, selectedSessionModelId, syncComposerToSession]);

  useEffect(() => {
    if (!turnActive || !selectedSession?.provider) return;
    const timer = window.setInterval(() => { void refreshProviderConnections(); }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshProviderConnections, selectedSession?.provider, turnActive]);

  useEffect(() => {
    let cancelled = false;
    const boot = async () => {
      setLoading(true); setPreferencesReady(false);
      try {
        const snapshot = await window.ade.projectConfig.get();
        const chat = snapshot.effective.ai?.chat;
        if (!cancelled) setSendOnEnter(chat?.sendOnEnter ?? true);
      } catch { /* defaults */ }
      try {
        if (lockedSingleSessionMode) {
          if (!cancelled && initialSessionSummary) { setSessions([initialSessionSummary]); setSelectedSessionId(lockSessionId ?? initialSessionSummary.sessionId); }
          await refreshAvailableModels();
        } else { await Promise.all([refreshAvailableModels(), refreshSessions()]); }
      } finally { if (!cancelled) { setLoading(false); setPreferencesReady(true); } }
    };
    void boot();
    return () => { cancelled = true; };
  }, [initialSessionSummary, lockSessionId, lockedSingleSessionMode, refreshAvailableModels, refreshSessions, setSendOnEnter, setSessions, setSelectedSessionId, setPreferencesReady]);

  useEffect(() => {
    if (loading || !availableModelIds.length) return;
    if (!modelId) return;
    if (availableModelIds.includes(modelId)) return;
    if (selectedSessionModelId) { setModelId(selectedSessionModelId); return; }
    const preferred = readLastUsedModelId();
    if (preferred && availableModelIds.includes(preferred)) { setModelId(preferred); } else { setModelId(availableModelIds[0]!); }
  }, [loading, availableModelIds, modelId, selectedSessionModelId, setModelId]);

  useEffect(() => {
    if (!reasoningTiers.length) { if (reasoningEffort !== null) setReasoningEffort(null); return; }
    if (reasoningEffort && reasoningTiers.includes(reasoningEffort)) return;
    const preferred = readLastUsedReasoningEffort({ laneId, modelId });
    setReasoningEffort(selectReasoningEffort({ tiers: reasoningTiers, preferred }));
  }, [laneId, modelId, reasoningEffort, reasoningTiers, setReasoningEffort]);

  useEffect(() => {
    if (!executionModeOptions.length) { if (executionMode !== "focused") setExecutionMode("focused"); return; }
    if (executionModeOptions.some((o) => o.value === executionMode)) return;
    setExecutionMode(executionModeOptions[0]!.value);
  }, [executionMode, executionModeOptions, setExecutionMode]);

  useClickOutside(handoffRef, () => setHandoffOpen(false), handoffOpen);

  useEffect(() => {
    if (!handoffOpen) return;
    const preferredTargetId = handoffAvailableModelIds.find((id) => id !== selectedSessionModelId) ?? handoffAvailableModelIds[0] ?? "";
    setHandoffModelId((current) => (current && handoffAvailableModelIds.includes(current)) ? current : preferredTargetId);
  }, [handoffAvailableModelIds, handoffOpen, selectedSessionModelId]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (!lockedSingleSessionMode) { void loadHistory(selectedSessionId); return; }
    const handle = window.setTimeout(() => { void loadHistory(selectedSessionId); }, 120);
    return () => window.clearTimeout(handle);
  }, [loadHistory, lockedSingleSessionMode, selectedSessionId]);

  useEffect(() => {
    if (!lockedSingleSessionMode) { void refreshComputerUseSnapshot(selectedSessionId); return; }
    const handle = window.setTimeout(() => { void refreshComputerUseSnapshot(selectedSessionId); }, 180);
    return () => window.clearTimeout(handle);
  }, [lockedSingleSessionMode, refreshComputerUseSnapshot, selectedSessionId]);

  useEffect(() => { setAttachments([]); setPromptSuggestion(null); setHandoffOpen(false); setHandoffBusy(false); }, [selectedSessionId, setAttachments, setPromptSuggestion]);

  useEffect(() => {
    if (!selectedSessionId) { setSdkSlashCommands([]); return; }
    let cancelled = false;
    window.ade.agentChat.slashCommands({ sessionId: selectedSessionId }).then((cmds) => { if (!cancelled) setSdkSlashCommands(cmds); }).catch(() => { if (!cancelled) setSdkSlashCommands([]); });
    return () => { cancelled = true; };
  }, [selectedSessionId, setSdkSlashCommands]);

  useEffect(() => {
    if (!selectedSessionId) { setSessionDelta(null); return; }
    let cancelled = false;
    window.ade.sessions.getDelta(selectedSessionId).then((delta) => {
      if (cancelled) return;
      if (delta && (delta.insertions > 0 || delta.deletions > 0)) { setSessionDelta({ insertions: delta.insertions, deletions: delta.deletions }); } else { setSessionDelta(null); }
    }).catch(() => { if (!cancelled) setSessionDelta(null); });
    return () => { cancelled = true; };
  }, [selectedSessionId, turnActive]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((envelope: AgentChatEventEnvelope) => {
      if (!knownSessionIdsRef.current.has(envelope.sessionId)) return;
      pendingEventQueueRef.current.push(envelope);
      if (envelope.event.type === "done") {
        if (eventFlushTimerRef.current != null) { window.clearTimeout(eventFlushTimerRef.current); eventFlushTimerRef.current = null; }
        flushQueuedEvents();
      } else { scheduleQueuedEventFlush(); }
      if (lockSessionId && envelope.sessionId === lockSessionId) { draftSelectionLockedRef.current = false; setSelectedSessionId(lockSessionId); }
      if (envelope.event.type === "prompt_suggestion" && "suggestion" in envelope.event) {
        if (envelope.sessionId === selectedSessionIdRef.current) setPromptSuggestion((envelope.event as any).suggestion);
      }
      if (envelope.event.type === "status" && envelope.event.turnStatus === "started") {
        if (envelope.sessionId === selectedSessionIdRef.current) setPromptSuggestion(null);
      }
      const shouldRefreshSlashCommands = envelope.event.type === "done" || (envelope.event.type === "system_notice" && (envelope.event.noticeKind === "auth" || envelope.event.message === "Session ready"));
      if (shouldRefreshSlashCommands) {
        scheduleSessionsRefresh();
        if (envelope.sessionId === selectedSessionIdRef.current) { window.ade.agentChat.slashCommands({ sessionId: envelope.sessionId }).then(setSdkSlashCommands).catch(() => {}); }
      }
    });
    return unsubscribe;
  }, [lockSessionId, flushQueuedEvents, scheduleQueuedEventFlush, scheduleSessionsRefresh, knownSessionIdsRef, pendingEventQueueRef, eventFlushTimerRef, draftSelectionLockedRef, setSelectedSessionId, setPromptSuggestion, setSdkSlashCommands]);

  useEffect(() => {
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      if (!selectedSessionId) return;
      if (event.owner?.kind === "chat_session" && event.owner.id === selectedSessionId) { setProofDrawerOpen(true); void refreshComputerUseSnapshot(selectedSessionId, { force: true }); }
    });
    return unsubscribe;
  }, [refreshComputerUseSnapshot, selectedSessionId]);

  useEffect(() => {
    const unsubscribe = window.ade.externalMcp.onEvent((event) => {
      if (event.type !== "usage-recorded" || !selectedSessionId) return;
      const usageEvent = event.usageEvent;
      const usageChatSessionId = usageEvent?.chatSessionId ?? usageEvent?.callerId ?? null;
      if (usageChatSessionId !== selectedSessionId) return;
      setProofDrawerOpen(true);
      void refreshComputerUseSnapshot(selectedSessionId, { force: true });
    });
    return unsubscribe;
  }, [refreshComputerUseSnapshot, selectedSessionId]);

  useEffect(() => { if (!selectedSessionId) setProofDrawerOpen(false); }, [selectedSessionId]);

  useEffect(() => { if (!preferencesReady || !modelId.trim().length) return; writeLastUsedModelId(modelId); }, [modelId, preferencesReady]);

  useEffect(() => { if (!preferencesReady) return; writeLastUsedReasoningEffort({ laneId, modelId, effort: reasoningEffort }); }, [laneId, modelId, preferencesReady, reasoningEffort]);

  // ── Eager session creation ──
  const eagerCreateFiredRef = useRef(false);
  useEffect(() => {
    if (eagerCreateFiredRef.current) return;
    if (!preferencesReady || !laneId || !modelId) return;
    if (selectedSessionId || lockSessionId || initialSessionId) return;
    if (forceDraft) return;
    eagerCreateFiredRef.current = true;
    void createSession();
  }, [preferencesReady, laneId, modelId, selectedSessionId, lockSessionId, initialSessionId, forceDraft, createSession]);

  // ── Model-switch on empty session ──
  const userChangedModelRef = useRef(false);
  useEffect(() => {
    if (!userChangedModelRef.current) return;
    userChangedModelRef.current = false;
    if (isPersistentIdentitySurface) return;
    if (!selectedSessionId || selectedEvents.length > 0 || turnActive) return;
    void (async () => {
      try {
        const desc = getModelById(modelId);
        const provider = desc?.isCliWrapped ? (desc.family === "openai" ? "codex" : "claude") : "unified";
        await window.ade.agentChat.updateSession({ sessionId: selectedSessionId, modelId, ...buildNativeControlPayload(provider) });
        await refreshSessions();
        window.ade.agentChat.slashCommands({ sessionId: selectedSessionId }).then(setSdkSlashCommands).catch(() => {});
      } catch {
        try { await window.ade.agentChat.dispose({ sessionId: selectedSessionId }); } catch { /* ignore */ }
        pendingSelectedSessionIdRef.current = null;
        setSelectedSessionId(null);
        eagerCreateFiredRef.current = false;
      }
    })();
  }, [buildNativeControlPayload, isPersistentIdentitySurface, modelId, selectedSessionId, selectedEvents.length, turnActive, refreshSessions, setSdkSlashCommands, pendingSelectedSessionIdRef, setSelectedSessionId]);

  // ── Render ────────────────────────────────────────────────────────

  if (!laneId) {
    return (
      <ChatSurfaceShell mode={surfaceMode} accentColor={presentation?.accentColor}>
        <div className="flex h-full items-center justify-center">
          <span className="font-sans text-[12px] text-muted-fg/30">Select a lane to start chatting</span>
        </div>
      </ChatSurfaceShell>
    );
  }
  const draftAccent = selectedModelDesc?.color ?? "#A1A1AA";
  const shellHeader = (
    <div className="space-y-3 px-4 py-3">
      <div className="flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="font-sans text-[13px] font-semibold text-fg/50">{resolvedTitle}</div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {canShowHandoff ? (
            <div ref={handoffRef} className="relative">
              <button type="button" className="inline-flex items-center rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] font-medium text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40" onClick={() => { setError(null); setHandoffOpen((c) => !c); }} disabled={handoffBlocked} title={handoffButtonTitle}>Chat handoff</button>
              {handoffOpen ? (
                <div className="absolute right-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,20,28,0.98),rgba(10,12,18,0.98))] p-3 shadow-[0_24px_90px_-40px_rgba(0,0,0,0.88)] backdrop-blur-xl">
                  <div className="space-y-1">
                    <div className="font-sans text-[12px] font-semibold text-fg/82">Start a sibling chat on another model</div>
                    <div className="text-[11px] leading-5 text-fg/54">ADE will create a new work chat, inject a handoff summary from this session, and route you into the new tab.</div>
                  </div>
                  <div className="mt-3"><UnifiedModelSelector value={handoffModelId} onChange={setHandoffModelId} availableModelIds={handoffAvailableModelIds} showReasoning={false} /></div>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button type="button" className="rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg" onClick={() => setHandoffOpen(false)}>Cancel</button>
                    <button type="button" className="rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] px-2.5 py-1 font-sans text-[11px] font-medium text-fg/86 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] disabled:cursor-not-allowed disabled:opacity-40" onClick={() => { void handoffSession(); }} disabled={!handoffModelId || handoffBusy}>{handoffBusy ? "Starting..." : "Create handoff chat"}</button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {isPersistentIdentitySurface && selectedSessionId ? (
            <button type="button" className="inline-flex items-center rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] font-medium text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg" onClick={() => { eventsBySessionRef.current = { ...eventsBySessionRef.current, [selectedSessionId]: [] }; setEventsBySession((prev) => ({ ...prev, [selectedSessionId]: [] })); setPendingInputsBySession((prev) => ({ ...prev, [selectedSessionId]: [] })); }}>Clear view</button>
          ) : null}
          {resolvedChips.map((chip) => (
            <span key={`${chip.label}:${chip.tone ?? "accent"}`} className={cn("inline-flex items-center rounded-md border px-2 py-1 font-sans text-[10px] font-medium", chatChipToneClass(chip.tone))}>{chip.label}</span>
          ))}
        </div>
      </div>
      {!lockSessionId && !hideSessionTabs ? (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
            {sessions.map((session) => {
              const desc = session.modelId ? getModelById(session.modelId) : resolveModelDescriptorForProvider(session.model, isModelProviderGroup(session.provider) ? session.provider : undefined);
              const title = chatSessionTitle(session);
              const isActive = session.sessionId === selectedSessionId;
              const isRunning = eventsHook.turnActiveBySession[session.sessionId] ?? false;
              return (
                <button key={session.sessionId} type="button" className={cn("inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 font-sans text-[11px] transition-colors", isActive ? "border-white/[0.08] bg-white/[0.05] font-medium text-fg/80" : "border-transparent text-muted-fg/40 hover:text-fg/60")} onClick={() => { pendingSelectedSessionIdRef.current = null; draftSelectionLockedRef.current = false; syncComposerToSession(session); setSelectedSessionId(session.sessionId); }}>
                  <ToolLogo toolType={chatToolTypeForProvider(session.provider)} size={10} />
                  <span className="max-w-[120px] truncate">{title}</span>
                  {session.completion ? (<span className={cn("inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em]", completionBadgeClass(session.completion.status))}>{session.completion.status}</span>) : null}
                  {isRunning ? (<span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: desc?.color ?? "#A78BFA" }} />) : null}
                </button>
              );
            })}
          </div>
          <button type="button" className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.06] text-muted-fg/30 transition-colors hover:text-fg/60" title="New chat" onClick={() => { pendingSelectedSessionIdRef.current = null; draftSelectionLockedRef.current = true; setError(null); setSelectedSessionId(null); clearDraft(); setAttachments([]); setComputerUsePolicy(createDefaultComputerUsePolicy()); }}>
            <Plus size={10} weight="bold" />
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <ChatSurfaceShell mode={surfaceMode} accentColor={presentation?.accentColor ?? draftAccent} header={shellHeader} footer={
          <AgentChatComposer
            surfaceMode={surfaceMode} sdkSlashCommands={sdkSlashCommands} modelId={modelId} availableModelIds={effectiveAvailableModelIds} reasoningEffort={reasoningEffort} draft={draft} attachments={attachments} pendingInput={pendingInput?.request ?? null} turnActive={turnActive} sendOnEnter={sendOnEnter} busy={busy} sessionProvider={sessionProvider} claudePermissionMode={claudePermissionMode} codexApprovalPolicy={codexApprovalPolicy} codexSandbox={codexSandbox} codexConfigSource={codexConfigSource} unifiedPermissionMode={unifiedPermissionMode} executionMode={selectedExecutionMode?.value ?? "focused"} computerUsePolicy={computerUsePolicy} computerUseSnapshot={computerUseSnapshot} proofOpen={proofDrawerOpen} proofArtifactCount={computerUseSnapshot?.artifacts.length ?? 0} executionModeOptions={launchModeEditable ? executionModeOptions : []} modelSelectionLocked={modelSelectionLocked || sessionMutationKind === "model" || turnActive} permissionModeLocked={permissionModeLocked || identitySessionSettingsBusy} messagePlaceholder={messagePlaceholder}
            onExecutionModeChange={setExecutionMode}
            onClaudePermissionModeChange={(value) => { void updateNativeControls({ claudePermissionMode: value }); }}
            onCodexApprovalPolicyChange={(value) => { void updateNativeControls({ codexApprovalPolicy: value }); }}
            onCodexSandboxChange={(value) => { void updateNativeControls({ codexSandbox: value }); }}
            onCodexConfigSourceChange={(value) => { void updateNativeControls({ codexConfigSource: value }); }}
            onUnifiedPermissionModeChange={(value) => { void updateNativeControls({ unifiedPermissionMode: value }); }}
            onComputerUsePolicyChange={handleComputerUsePolicyChange}
            onToggleProof={() => setProofDrawerOpen((c) => !c)}
            onModelChange={(nextModelId) => {
              if (selectedSessionModelId && effectiveAvailableModelIds.length && !effectiveAvailableModelIds.includes(nextModelId)) return;
              if (isPersistentIdentitySurface && sessionMutationKind) return;
              userChangedModelRef.current = true;
              const previousModelId = modelId;
              const previousReasoningEffort = reasoningEffort;
              setModelId(nextModelId);
              const nextDesc = getModelById(nextModelId);
              const tiers = nextDesc?.reasoningTiers ?? [];
              const preferred = readLastUsedReasoningEffort({ laneId, modelId: nextModelId });
              const nextReasoningEffort = selectReasoningEffort({ tiers, preferred });
              setReasoningEffort(nextReasoningEffort);
              if (selectedSessionId && isPersistentIdentitySurface && !turnActive) {
                const nextProvider = nextDesc?.isCliWrapped ? (nextDesc.family === "openai" ? "codex" : "claude") : "unified";
                const nextModel = nextDesc ? getRuntimeModelRefForDescriptor(nextDesc, nextProvider) : nextModelId;
                setSessionMutationKind("model");
                patchSessionSummary(selectedSessionId, { provider: nextProvider, model: nextModel, modelId: nextModelId, reasoningEffort: nextReasoningEffort, ...buildNativeControlPayload(nextProvider) });
                void window.ade.agentChat.updateSession({ sessionId: selectedSessionId, modelId: nextModelId, reasoningEffort: nextReasoningEffort, ...buildNativeControlPayload(nextProvider), computerUse: computerUsePolicy }).then(() => {
                  window.ade.agentChat.slashCommands({ sessionId: selectedSessionId }).then(setSdkSlashCommands).catch(() => {});
                  void refreshSessions().catch(() => {});
                }).catch((err) => { setModelId(previousModelId); setReasoningEffort(previousReasoningEffort); void refreshSessions().catch(() => {}); setError(err instanceof Error ? err.message : String(err)); }).finally(() => { setSessionMutationKind(null); });
              }
              if (selectedSessionId && nextDesc?.family === "anthropic" && nextDesc?.isCliWrapped) {
                window.ade.agentChat.warmupModel({ sessionId: selectedSessionId, modelId: nextModelId }).catch(() => {});
              }
            }}
            onReasoningEffortChange={setReasoningEffort}
            onDraftChange={(value) => { setDraft(value); if (value.length > 0) setPromptSuggestion(null); }}
            onClearDraft={() => clearDraft()}
            onSubmit={() => { setPromptSuggestion(null); void submit(); }}
            onInterrupt={() => { void interrupt(); }}
            onApproval={(decision) => { void approve(decision); }}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onSearchAttachments={searchAttachments}
            includeProjectDocs={includeProjectDocs}
            onIncludeProjectDocsChange={setIncludeProjectDocs}
            onClearEvents={() => { if (selectedSessionId) { eventsBySessionRef.current = { ...eventsBySessionRef.current, [selectedSessionId]: [] }; setEventsBySession((prev) => ({ ...prev, [selectedSessionId]: [] })); setPendingInputsBySession((prev) => ({ ...prev, [selectedSessionId]: [] })); } }}
            promptSuggestion={promptSuggestion}
            subagentSnapshots={selectedSubagentSnapshots}
          />
        } bodyClassName="flex min-h-0 flex-col overflow-hidden">
        {error ? (<div className="border-b border-red-500/10 px-4 py-2 font-mono text-[10px] text-red-300/80">{error}</div>) : null}
        {selectedSessionId && activeProviderConnection?.blocker && !activeProviderConnection.runtimeAvailable ? (
          <div className="border-b border-amber-500/10 bg-amber-500/[0.04] px-4 py-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200/70">{activeProviderConnection.provider === "claude" ? "Claude runtime" : "Codex runtime"}</div>
            <div className="mt-1 text-[12px] leading-5 text-amber-100/80">{activeProviderConnection.blocker}</div>
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-hidden">
          {loading ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-3">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:0ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:150ms]" />
                  <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-[var(--chat-accent)] [animation-delay:300ms]" />
                </div>
                <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-fg/25">Loading sessions...</span>
              </div>
            </div>
          ) : selectedSessionId ? (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {proofDrawerOpen ? (
                <div className="border-b border-white/[0.05] bg-[linear-gradient(180deg,rgba(12,17,28,0.92),rgba(9,12,20,0.88))]">
                  <div className="flex items-center justify-between gap-3 px-4 py-3">
                    <div>
                      <div className="font-sans text-[12px] font-medium text-fg/82">Proof drawer</div>
                      <div className="mt-1 text-[11px] text-fg/54">Inspect retained screenshots, traces, logs, and verification output for this chat.</div>
                    </div>
                    <button type="button" className="rounded-[var(--chat-radius-pill)] border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-sans text-[11px] font-medium text-fg/58 transition-colors hover:text-fg/82" onClick={() => setProofDrawerOpen(false)} title="Hide proof drawer">Hide proof</button>
                  </div>
                  <div className="max-h-[48vh] overflow-auto px-4 pb-4">
                    <ChatComputerUsePanel laneId={laneId} sessionId={selectedSessionId} policy={computerUsePolicy} snapshot={computerUseSnapshot} onRefresh={() => refreshComputerUseSnapshot(selectedSessionId, { force: true })} />
                  </div>
                </div>
              ) : null}
              <AgentChatMessageList
                key={selectedSessionId ?? "chat-draft"} events={selectedEvents} showStreamingIndicator={turnActive} className="min-h-0 border-0" surfaceMode={surfaceMode} surfaceProfile={surfaceProfile} assistantLabel={assistantLabel}
                onApproval={(itemId, decision, responseText) => {
                  if (!selectedSessionId) return;
                  window.ade.agentChat.respondToInput({ sessionId: selectedSessionId, itemId, decision, responseText }).then(() => {
                    setPendingInputsBySession((prev) => ({ ...prev, [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((e) => e.itemId !== itemId) }));
                  }).catch((err) => { setError(err instanceof Error ? err.message : String(err)); });
                }}
              />
              {selectedEvents.length > 0 ? (
                <ChatContextMeter events={selectedEvents} contextWindow={selectedModelDesc?.contextWindow} />
              ) : null}
              {sessionDelta ? (
                <div className="flex items-center gap-3 border-t border-white/[0.04] px-4 py-1.5 font-mono text-[11px]">
                  <span className="text-emerald-400/70">+{sessionDelta.insertions}</span>
                  <span className="text-red-400/70">-{sessionDelta.deletions}</span>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6">
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: draftAccent }} />
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[2px] text-muted-fg/40">{laneDisplayLabel}</span>
                </div>
                <div className="font-sans text-[15px] font-medium tracking-tight text-fg/60">Start typing below</div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {["Explain the project structure", "Review recent changes", "Plan the next feature", "Find bugs and propose fixes"].map((prompt) => (
                    <button key={prompt} type="button" className="rounded-[var(--chat-radius-pill)] border border-white/8 bg-black/10 px-3 py-2 text-left font-mono text-[10px] text-muted-fg/42 transition-colors hover:border-white/16 hover:text-fg/72" onClick={() => setDraft(prompt)}>{prompt}</button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </ChatSurfaceShell>
      {pendingInput && selectedSessionId && (pendingInput.request.kind === "question" || pendingInput.request.kind === "structured_question") ? (
        <AgentQuestionModal request={pendingInput.request} onClose={() => { void approve("cancel"); }} onSubmit={({ answers, responseText }) => { void approve("accept", responseText, answers); }} onDecline={() => { void approve("decline"); }} />
      ) : null}
    </>
  );
}
