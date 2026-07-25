import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Globe, SpinnerGap, TerminalWindow } from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
  AgentChatApprovalDecision,
  AgentChatEventEnvelope,
  AgentChatEventHistorySnapshot,
  AgentChatModelCatalog,
  AgentChatPermissionMode,
  AgentChatSessionSummary,
  PersonalChatAction,
  PersonalChatCallArgs,
  PersonalChatCallResponse,
} from "../../../shared/types";
import {
  getModelById,
  getRuntimeModelRefForDescriptor,
  modelSupportsFastMode,
  resolveProviderGroupForModel,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { AgentChatMessageList } from "../chat/AgentChatMessageList";
import { ChatBuiltInBrowserPanel } from "../chat/ChatBuiltInBrowserPanel";
import { ChatSurfaceShell } from "../chat/ChatSurfaceShell";
import { PersonalTerminalPanel } from "./PersonalTerminalPanel";
import { ProjectlessComposer } from "./ProjectlessComposer";
import { ProjectlessHero } from "./ProjectlessHero";
import { ProjectlessSidebar } from "./ProjectlessSidebar";
import { sessionPreview, sessionTitle } from "./sessionHelpers";
import { buildChatAppearanceRootStyle } from "../chat/chatAppearance";
import { effectiveChatAccent } from "../chat/chatSurfaceTheme";
import { descriptorsFromAgentChatModelCatalog } from "../shared/ModelPicker/modelCatalog";
import { isWebClientMode } from "../../lib/webClientMode";
import {
  ADE_OPEN_BUILT_IN_BROWSER_EVENT,
  navigateUrlInAdeBrowser,
  type OpenBuiltInBrowserDetail,
} from "../../lib/openExternal";
import { useAppStore } from "../../state/appStore";

type ToolPanel = "browser" | "terminal" | null;

type PersonalChatsBridge = {
  call(request: PersonalChatCallArgs): Promise<PersonalChatCallResponse>;
  streamEvents(request?: { cursor?: number; limit?: number }): Promise<{
    events: Array<{ id: number; payload: Record<string, unknown> }>;
    nextCursor: number;
    hasMore: boolean;
  }>;
};

const EMPTY_EVENTS: AgentChatEventEnvelope[] = [];
const DEFAULT_MODEL_ID = "";

function bridge(): PersonalChatsBridge {
  const candidate = (window.ade as typeof window.ade & { personalChats?: PersonalChatsBridge }).personalChats;
  if (!candidate) throw new Error("Personal chats are not available in this ADE runtime.");
  return candidate;
}

function resultOf<T>(response: PersonalChatCallResponse | T): T {
  if (response && typeof response === "object" && "result" in response) {
    return (response as PersonalChatCallResponse).result as T;
  }
  return response as T;
}

async function callPersonal<T>(action: PersonalChatAction, args?: Record<string, unknown>): Promise<T> {
  const request = (args === undefined ? { action } : { action, args }) as PersonalChatCallArgs;
  return resultOf<T>(await bridge().call(request));
}

function groupLabel(value: string | null | undefined): string {
  const timestamp = value ? Date.parse(value) : NaN;
  if (!Number.isFinite(timestamp)) return "Older";
  const days = Math.floor((Date.now() - timestamp) / 86_400_000);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return "Previous 7 days";
  return "Older";
}

function envelopeFromPayload(payload: Record<string, unknown>): AgentChatEventEnvelope | null {
  const candidates = [payload.envelope, payload.chatEvent, payload.event, payload];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    const record = candidate as Record<string, unknown>;
    if (
      typeof record.sessionId === "string"
      && typeof record.timestamp === "string"
      && record.event
      && typeof record.event === "object"
    ) {
      return record as unknown as AgentChatEventEnvelope;
    }
  }
  return null;
}

function eventKeyPart(value: unknown): string | number | boolean | null {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? value
    : null;
}

const eventKeyCache = new WeakMap<AgentChatEventEnvelope, string>();

function eventKey(event: AgentChatEventEnvelope): string {
  const cached = eventKeyCache.get(event);
  if (cached) return cached;

  if (typeof event.sequence === "number" && Number.isFinite(event.sequence)) {
    const sequenceKey = JSON.stringify([event.sessionId, "sequence", event.sequence]);
    eventKeyCache.set(event, sequenceKey);
    return sequenceKey;
  }

  const body = event.event as unknown as Record<string, unknown>;
  const content = [body.text, body.message, body.summary, body.detail].find((value) => typeof value === "string");
  let contentFingerprint: string | null = null;
  if (typeof content === "string") {
    let hash = 2_166_136_261;
    for (let index = 0; index < content.length; index += 1) {
      hash = Math.imul(hash ^ content.charCodeAt(index), 16_777_619);
    }
    contentFingerprint = `${content.length}:${(hash >>> 0).toString(36)}`;
  }

  // Legacy envelopes may not carry a sequence. Include lifecycle and stable
  // entity identifiers before the coarse timestamp/content fallback so rapid
  // started/completed events remain distinct while exact replays still dedupe.
  const fallbackKey = JSON.stringify([
    event.sessionId,
    eventKeyPart(body.type),
    eventKeyPart(body.turnId),
    eventKeyPart(body.turnStatus),
    eventKeyPart(body.status),
    eventKeyPart(body.state),
    eventKeyPart(body.reviewStatus),
    eventKeyPart(body.deliveryState),
    eventKeyPart(body.itemId),
    eventKeyPart(body.logicalItemId),
    eventKeyPart(body.messageId),
    eventKeyPart(body.taskId),
    eventKeyPart(body.agentId),
    eventKeyPart(body.runId),
    eventKeyPart(body.compactionId),
    eventKeyPart(body.steerId),
    eventKeyPart(body.stepNumber),
    eventKeyPart(body.id),
    eventKeyPart(body.parentItemId),
    eventKeyPart(body.targetItemId),
    eventKeyPart(body.threadId),
    eventKeyPart(body.sourceSessionId),
    eventKeyPart(body.activity),
    eventKeyPart(body.kind),
    eventKeyPart(body.action),
    eventKeyPart(body.trigger),
    eventKeyPart(body.updateKind),
    event.provenance?.messageId ?? null,
    event.provenance?.providerMessageId ?? null,
    event.provenance?.attemptId ?? null,
    event.provenance?.stepKey ?? null,
    event.timestamp,
    contentFingerprint,
  ]);
  eventKeyCache.set(event, fallbackKey);
  return fallbackKey;
}

function mergeEvents(current: AgentChatEventEnvelope[], incoming: AgentChatEventEnvelope[]): AgentChatEventEnvelope[] {
  if (!incoming.length) return current;
  const seen = new Set(current.map(eventKey));
  const next = [...current];
  for (const event of incoming) {
    const key = eventKey(event);
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(event);
  }
  next.sort((left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp));
  return next;
}

export function PersonalChatsPage({ standalone = false }: { standalone?: boolean }) {
  const navigate = useNavigate();
  const projectBinding = useAppStore((state) => state.projectBinding);
  const chatFontSizePx = useAppStore((state) => state.chatFontSizePx);
  const chatTranscriptDensity = useAppStore((state) => state.chatTranscriptDensity);
  const chatChromeTint = useAppStore((state) => state.chatChromeTint);
  const chatShellGeometry = useAppStore((state) => state.chatShellGeometry);
  const targetKey = projectBinding?.kind === "remote" ? projectBinding.key : "local-machine";
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [catalog, setCatalog] = useState<AgentChatModelCatalog | null>(null);
  const [modelId, setModelId] = useState(DEFAULT_MODEL_ID);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [permissionMode, setPermissionMode] = useState<AgentChatPermissionMode>("default");
  const [fastMode, setFastMode] = useState(false);
  const [draft, setDraft] = useState("");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [toolPanel, setToolPanel] = useState<ToolPanel>(null);
  const [mobileListOpen, setMobileListOpen] = useState(true);
  const cursorRef = useRef(0);
  const targetGenerationRef = useRef(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const refreshSessions = useCallback(async (generation = targetGenerationRef.current) => {
    const rows = await callPersonal<AgentChatSessionSummary[]>("list", { includeArchived: false });
    if (generation !== targetGenerationRef.current) return;
    const ordered = [...(Array.isArray(rows) ? rows : [])].sort(
      (left, right) => Date.parse(right.lastActivityAt) - Date.parse(left.lastActivityAt),
    );
    setSessions(ordered);
    setSelectedId((current) => current && ordered.some((row) => row.sessionId === current) ? current : null);
  }, []);

  useEffect(() => {
    const generation = ++targetGenerationRef.current;
    cursorRef.current = 0;
    setSessions([]);
    setSelectedId(null);
    setEventsBySession({});
    setToolPanel(null);
    setCatalog(null);
    setModelId(DEFAULT_MODEL_ID);
    setLoading(true);
    setError(null);
    void refreshSessions(generation).catch((reason) => {
      if (generation === targetGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (generation === targetGenerationRef.current) setLoading(false);
    });
    void callPersonal<AgentChatModelCatalog>("modelCatalog", { mode: "cached" })
      .then((next) => {
        if (generation === targetGenerationRef.current) setCatalog(next);
      })
      .catch((reason) => {
        if (generation === targetGenerationRef.current) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
  }, [refreshSessions, targetKey]);

  useEffect(() => {
    const openPersonalBrowser = (rawEvent: Event) => {
      const event = rawEvent as CustomEvent<OpenBuiltInBrowserDetail>;
      if (!event.detail?.url || isWebClientMode()) return;
      event.preventDefault();
      setToolPanel("browser");
      navigateUrlInAdeBrowser(event.detail.url, {
        newTab: true,
        tabCollection: "personal",
      }, {
        fallbackToExternal: false,
        onFailure: () => setError("ADE Browser couldn't open that link. Try again."),
      });
    };
    window.addEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openPersonalBrowser);
    return () => window.removeEventListener(ADE_OPEN_BUILT_IN_BROWSER_EVENT, openPersonalBrowser);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const generation = targetGenerationRef.current;
    let timer: number | null = null;
    const poll = async () => {
      if (cancelled || generation !== targetGenerationRef.current) return;
      try {
        const result = await bridge().streamEvents({ cursor: cursorRef.current, limit: 200 });
        if (cancelled || generation !== targetGenerationRef.current) return;
        cursorRef.current = result.nextCursor ?? cursorRef.current;
        const envelopes = (result.events ?? [])
          .map((entry) => envelopeFromPayload(entry.payload ?? {}))
          .filter((event): event is AgentChatEventEnvelope => event != null);
        if (envelopes.length) {
          setEventsBySession((current) => {
            const next = { ...current };
            for (const event of envelopes) {
              next[event.sessionId] = mergeEvents(next[event.sessionId] ?? [], [event]);
            }
            return next;
          });
          void refreshSessions(generation).catch(() => undefined);
        }
      } catch (reason) {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      } finally {
        if (!cancelled) timer = window.setTimeout(poll, 700);
      }
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
    };
  }, [refreshSessions, targetKey]);

  useEffect(() => {
    if (!selectedId) return;
    const generation = targetGenerationRef.current;
    setMobileListOpen(false);
    void callPersonal<AgentChatEventHistorySnapshot>("getEventHistory", {
      sessionId: selectedId,
      maxEvents: 1_500,
      maxBytes: 4 * 1024 * 1024,
    }).then((snapshot) => {
      if (generation !== targetGenerationRef.current || snapshot.sessionId !== selectedId) return;
      setEventsBySession((current) => ({
        ...current,
        [selectedId]: mergeEvents(snapshot.events ?? [], current[selectedId] ?? []),
      }));
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [selectedId, targetKey]);

  const selectedSession = sessions.find((session) => session.sessionId === selectedId) ?? null;
  const selectedEvents = selectedId ? eventsBySession[selectedId] ?? EMPTY_EVENTS : EMPTY_EVENTS;
  // Stable row-facing handlers so a draft-only keystroke (which rerenders this
  // page) does not defeat the memoized AgentChatMessageList boundary.
  const handleListApproval = useCallback(
    (
      itemId: string,
      decision: AgentChatApprovalDecision,
      responseText?: string | null,
      answers?: Record<string, string | string[]>,
    ) => {
      if (!selectedId) return;
      void callPersonal<void>("respondToInput", { sessionId: selectedId, itemId, decision, responseText, answers });
    },
    [selectedId],
  );
  const appendDraft = useCallback(
    (text: string) => setDraft((current) => (current ? `${current}\n${text}` : text)),
    [],
  );
  const dynamicCatalog = useMemo(
    () => catalog ? descriptorsFromAgentChatModelCatalog(catalog) : null,
    [catalog],
  );
  const models = useMemo<readonly ModelDescriptor[]>(
    () => dynamicCatalog?.models ?? [],
    [dynamicCatalog],
  );
  const availableModelIds = useMemo(
    () => dynamicCatalog?.availableModelIds ?? [],
    [dynamicCatalog],
  );
  const hasValidNewSessionModel = availableModelIds.includes(modelId)
    && models.some((model) => model.id === modelId);

  useEffect(() => {
    if (!selectedSession) return;
    setModelId(selectedSession.modelId ?? modelId);
    setReasoningEffort(selectedSession.reasoningEffort ?? null);
    setPermissionMode(selectedSession.permissionMode ?? "default");
    setFastMode(selectedSession.fastMode === true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    if (availableModelIds.includes(modelId)) return;
    const fallback = availableModelIds[0];
    if (fallback) setModelId(fallback);
  }, [availableModelIds, modelId]);

  const updateSelected = useCallback(async (patch: Record<string, unknown>) => {
    if (!selectedId) return;
    await callPersonal<AgentChatSessionSummary>("updateSession", { sessionId: selectedId, ...patch });
    await refreshSessions();
  }, [refreshSessions, selectedId]);

  const handleModelChange = useCallback((nextModelId: string) => {
    if (!availableModelIds.includes(nextModelId)) return;
    setModelId(nextModelId);
    const descriptor = models.find((model) => model.id === nextModelId) ?? getModelById(nextModelId);
    if (selectedId && descriptor) {
      void updateSelected({
        modelId: descriptor.id,
        model: getRuntimeModelRefForDescriptor(descriptor),
        provider: resolveProviderGroupForModel(descriptor),
      }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
    }
  }, [availableModelIds, models, selectedId, updateSelected]);

  const createSession = useCallback(async (): Promise<AgentChatSessionSummary> => {
    const descriptor = models.find((model) => model.id === modelId);
    if (!descriptor || !availableModelIds.includes(descriptor.id)) {
      throw new Error("Choose an available model before starting a chat.");
    }
    const created = await callPersonal<AgentChatSessionSummary>("create", {
      provider: resolveProviderGroupForModel(descriptor),
      model: getRuntimeModelRefForDescriptor(descriptor),
      modelId: descriptor.id,
      reasoningEffort,
      permissionMode,
      fastMode: modelSupportsFastMode(descriptor) ? fastMode : false,
      title: null,
    });
    await refreshSessions();
    setSelectedId(created.sessionId);
    return created;
  }, [availableModelIds, fastMode, modelId, models, permissionMode, reasoningEffort, refreshSessions]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending || (!selectedSession && !hasValidNewSessionModel)) return;
    setSending(true);
    setError(null);
    try {
      const session = selectedSession ?? await createSession();
      await callPersonal<void>("send", {
        sessionId: session.sessionId,
        text,
        reasoningEffort,
      });
      setDraft("");
      setSelectedId(session.sessionId);
      await refreshSessions();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSending(false);
    }
  }, [createSession, draft, hasValidNewSessionModel, reasoningEffort, refreshSessions, selectedSession, sending]);

  const removeSession = useCallback(async (sessionId: string, action: "archive" | "delete") => {
    setMenuId(null);
    setError(null);
    try {
      await callPersonal<void>(action, { sessionId });
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      setError(`Could not ${action} this chat${detail ? `: ${detail}` : "."}`);
      await refreshSessions().catch(() => undefined);
      return;
    }

    setEventsBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    if (selectedId === sessionId) setSelectedId(null);
    try {
      await refreshSessions();
    } catch (reason) {
      const detail = reason instanceof Error ? reason.message : String(reason);
      const completedAction = action === "archive" ? "archived" : "deleted";
      setError(`The chat was ${completedAction}, but the chat list could not refresh${detail ? `: ${detail}` : "."}`);
    }
  }, [refreshSessions, selectedId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return needle
      ? sessions.filter((session) => `${sessionTitle(session)} ${sessionPreview(session)}`.toLowerCase().includes(needle))
      : sessions;
  }, [query, sessions]);
  const grouped = useMemo(() => {
    const groups = new Map<string, AgentChatSessionSummary[]>();
    for (const session of filtered) {
      const label = groupLabel(session.lastActivityAt);
      groups.set(label, [...(groups.get(label) ?? []), session]);
    }
    return [...groups.entries()];
  }, [filtered]);

  const appearanceStyle = useMemo(
    () => buildChatAppearanceRootStyle({ chatFontSizePx, transcriptDensity: chatTranscriptDensity }),
    [chatFontSizePx, chatTranscriptDensity],
  );
  const browserAvailable = !isWebClientMode() && Boolean(window.ade?.builtInBrowser);
  const turnActive = selectedSession?.status === "active";
  const selectedDescriptor = models.find((model) => model.id === modelId) ?? getModelById(modelId);
  const accentColor = selectedDescriptor?.color ?? "#A78BFA";
  const isRemote = projectBinding?.kind === "remote";
  const machineLabel = isRemote ? projectBinding.runtimeName : "This machine";
  // Only declare the provider unavailable once the catalog has actually
  // loaded — an in-flight fetch is not "no provider".
  const providerUnavailable = catalog !== null && availableModelIds.length === 0;
  const canStartSend = Boolean(selectedSession) || hasValidNewSessionModel;
  // Hero only for a brand-new chat: a selected session docks immediately even
  // while its event history is still loading, so the greeting never flashes.
  const heroMode = selectedId == null && selectedEvents.length === 0;
  // The eventsBySession key appears when the history fetch completes, so a
  // selected session with no key is still loading; a present-but-empty list is
  // a real (possibly failed-first-send) empty chat, not a pending fetch.
  const historySettled = selectedId != null && (eventsBySession[selectedId] !== undefined || Boolean(error));
  const showReconnecting = Boolean(error) && isRemote;

  const applyPrompt = useCallback((prefill: string) => {
    setDraft(prefill);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, []);

  const composer = (
    <ProjectlessComposer
      variant={heroMode ? "hero" : "docked"}
      appearanceStyle={appearanceStyle}
      accentColor={effectiveChatAccent(accentColor, chatChromeTint)}
      draft={draft}
      onDraftChange={setDraft}
      onSubmit={() => void submit()}
      sending={sending}
      turnActive={turnActive}
      models={models}
      availableModelIds={availableModelIds}
      modelId={modelId}
      onModelChange={handleModelChange}
      catalogReady={catalog !== null}
      reasoningEffort={reasoningEffort}
      onReasoningChange={(next) => { setReasoningEffort(next); void updateSelected({ reasoningEffort: next }); }}
      permissionMode={permissionMode}
      onPermissionChange={(next) => { setPermissionMode(next); void updateSelected({ permissionMode: next }); }}
      fastMode={fastMode}
      onFastModeToggle={(next) => { setFastMode(next); void updateSelected({ fastMode: next }); }}
      selectedDescriptor={selectedDescriptor}
      canStartSend={canStartSend}
      showInterrupt={turnActive && Boolean(selectedId)}
      onInterrupt={() => { if (selectedId) void callPersonal<void>("interrupt", { sessionId: selectedId }); }}
      error={error}
      onDismissError={() => setError(null)}
      textareaRef={textareaRef}
    />
  );

  return (
    <div className="flex h-full min-h-0 bg-bg text-fg" data-testid="personal-chats-page" data-target={targetKey}>
      <ProjectlessSidebar
        standalone={standalone}
        machineLabel={machineLabel}
        grouped={grouped}
        loading={loading}
        query={query}
        onQueryChange={setQuery}
        selectedId={selectedId}
        onSelect={setSelectedId}
        onNewChat={() => { setSelectedId(null); setDraft(""); setMobileListOpen(false); setMenuId(null); }}
        onBack={() => navigate("/work")}
        mobileListOpen={mobileListOpen}
        menuId={menuId}
        onToggleMenu={setMenuId}
        onRemove={(id, action) => void removeSession(id, action)}
      />

      <main className="relative min-w-0 flex-1">
        <ChatSurfaceShell
          mode="standard"
          accentColor={accentColor}
          chromeTint={chatChromeTint}
          shellGeometry={chatShellGeometry}
          header={(
            <div className="flex h-11 items-center gap-2 border-b border-white/[0.055] px-3">
              <button type="button" className="hidden h-7 w-7 items-center justify-center rounded-md text-muted-fg/55 hover:bg-white/[0.06] max-md:flex" onClick={() => setMobileListOpen(true)} aria-label="Show chats"><ArrowLeft size={15} /></button>
              <div className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-fg/75">{selectedSession ? sessionTitle(selectedSession) : "New chat"}</div>
              {showReconnecting ? (
                <span className="flex shrink-0 items-center gap-1.5 rounded-full border border-amber-400/20 bg-amber-500/10 px-2 py-0.5 font-sans text-[10px] text-amber-200/80">
                  <SpinnerGap size={11} className="animate-spin" /> Reconnecting…
                </span>
              ) : null}
              {browserAvailable ? (
                <button type="button" onClick={() => setToolPanel((current) => current === "browser" ? null : "browser")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "browser" ? "border-sky-300/25 bg-sky-500/10 text-sky-200" : "border-white/[0.06] bg-white/[0.025] text-muted-fg/45 hover:text-fg")} title="Browser" aria-label="Toggle browser"><Globe size={14} /></button>
              ) : null}
              <button type="button" onClick={() => setToolPanel((current) => current === "terminal" ? null : "terminal")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "terminal" ? "border-violet-300/25 bg-violet-500/10 text-violet-200" : "border-white/[0.06] bg-white/[0.025] text-muted-fg/45 hover:text-fg")} title="Terminal" aria-label="Toggle terminal"><TerminalWindow size={14} /></button>
            </div>
          )}
          footer={heroMode ? undefined : composer}
        >
          <div data-chat-appearance-root style={appearanceStyle} className="relative flex h-full min-h-0">
            <div className="min-w-0 flex-1">
              {/* The hero (with its composer) paints immediately during the
                  initial fetch — the sidebar spinner already signals loading. */}
              {loading && !heroMode ? (
                <div className="flex h-full items-center justify-center"><SpinnerGap size={22} className="animate-spin text-muted-fg/35" /></div>
              ) : selectedEvents.length ? (
                <div className="h-full motion-safe:animate-[ade-chat-dock-in_0.28s_ease-out]">
                  <AgentChatMessageList
                    events={selectedEvents}
                    showStreamingIndicator={turnActive}
                    laneId={null}
                    sessionId={selectedId}
                    assistantLabel={selectedSession ? sessionTitle(selectedSession) : "ADE"}
                    onApproval={handleListApproval}
                    onInsertDraft={appendDraft}
                  />
                </div>
              ) : heroMode ? (
                <ProjectlessHero composer={composer} onSelectPrompt={applyPrompt} providerUnavailable={providerUnavailable} />
              ) : historySettled ? (
                <div className="flex h-full items-center justify-center px-6">
                  <p className="text-center font-sans text-[12px] leading-5 text-muted-fg/40">No messages in this chat yet.</p>
                </div>
              ) : (
                <div className="flex h-full items-center justify-center">
                  <SpinnerGap size={18} className="animate-spin text-muted-fg/25" />
                </div>
              )}
            </div>
            {toolPanel === "browser" ? (
              <div className="w-[min(44%,560px)] min-w-[340px] border-l border-white/[0.07] bg-bg max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92%,560px)] max-lg:shadow-2xl">
                <ChatBuiltInBrowserPanel sessionId={selectedId} projectRootOverride={null} onInsertDraft={appendDraft} />
              </div>
            ) : null}
            {toolPanel === "terminal" ? (
              <div className="w-[min(44%,560px)] min-w-[340px] border-l border-white/[0.07] bg-bg max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92%,560px)] max-lg:shadow-2xl">
                <PersonalTerminalPanel chatSessionId={selectedId} onClose={() => setToolPanel(null)} />
              </div>
            ) : null}
          </div>
        </ChatSurfaceShell>
      </main>
    </div>
  );
}
