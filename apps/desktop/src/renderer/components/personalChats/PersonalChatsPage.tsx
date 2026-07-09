import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ArrowLeft,
  ChatCircleDots,
  DotsThree,
  Globe,
  House,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  SpinnerGap,
  Stop,
  TerminalWindow,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useNavigate } from "react-router-dom";
import type {
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
import { buildChatAppearanceRootStyle } from "../chat/chatAppearance";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { descriptorsFromAgentChatModelCatalog } from "../shared/ModelPicker/modelCatalog";
import { ToolLogo } from "../terminals/ToolLogos";
import { isWebClientMode } from "../../lib/webClientMode";
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

function sessionTitle(session: AgentChatSessionSummary): string {
  const title = session.title?.trim() || session.goal?.trim() || session.summary?.trim();
  if (title) return title;
  return getModelById(session.modelId ?? "")?.displayName ?? "New chat";
}

function sessionPreview(session: AgentChatSessionSummary): string {
  return session.lastOutputPreview?.trim() || session.summary?.trim() || "Start a conversation";
}

function relativeTime(value: string | null | undefined): string {
  if (!value) return "";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : new Date(timestamp).toLocaleDateString(undefined, { month: "short", day: "numeric" });
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

function providerToolType(provider: string): Parameters<typeof ToolLogo>[0]["toolType"] {
  if (provider === "claude") return "claude-chat";
  if (provider === "codex") return "codex-chat";
  if (provider === "cursor") return "cursor";
  if (provider === "droid") return "droid-chat";
  return "opencode-chat";
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
    void Promise.all([
      refreshSessions(generation),
      callPersonal<AgentChatModelCatalog>("modelCatalog", { mode: "cached" })
        .then((next) => {
          if (generation === targetGenerationRef.current) setCatalog(next);
        }),
    ]).catch((reason) => {
      if (generation === targetGenerationRef.current) {
        setError(reason instanceof Error ? reason.message : String(reason));
      }
    }).finally(() => {
      if (generation === targetGenerationRef.current) setLoading(false);
    });
  }, [refreshSessions, targetKey]);

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
    await callPersonal<void>(action, { sessionId });
    setEventsBySession((current) => {
      const next = { ...current };
      delete next[sessionId];
      return next;
    });
    if (selectedId === sessionId) setSelectedId(null);
    await refreshSessions();
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

  return (
    <div className="flex h-full min-h-0 bg-bg text-fg" data-testid="personal-chats-page" data-target={targetKey}>
      <aside className={cn(
        "relative w-[286px] shrink-0 border-r border-white/[0.06] bg-black/[0.12]",
        "max-md:absolute max-md:inset-y-0 max-md:left-0 max-md:z-40 max-md:w-[min(88vw,320px)] max-md:shadow-2xl",
        !mobileListOpen && "max-md:hidden",
      )}>
        <div aria-hidden className="pointer-events-none absolute inset-0 hidden max-md:block" style={{ background: "var(--color-bg)" }} />
        <div className="relative z-10 flex h-full min-h-0 flex-col">
          <div className="flex items-center gap-2 px-3 pb-2 pt-3">
            {standalone ? (
              <button type="button" onClick={() => navigate("/work")} className="flex h-8 w-8 items-center justify-center rounded-lg text-fg/55 hover:bg-white/[0.06] hover:text-fg" aria-label="Back to home">
                <House size={16} />
              </button>
            ) : null}
            <div className="min-w-0 flex-1">
              <div className="font-sans text-[15px] font-semibold tracking-tight">Chats</div>
              <div className="truncate text-[10px] text-muted-fg/45">
                {projectBinding?.kind === "remote" ? projectBinding.runtimeName : "This machine"}
              </div>
            </div>
            <button
              type="button"
              className="flex h-8 items-center gap-1.5 rounded-lg border border-accent/25 bg-accent/10 px-2.5 font-sans text-[11px] font-medium text-accent hover:bg-accent/15"
              onClick={() => { setSelectedId(null); setDraft(""); setMobileListOpen(false); }}
            >
              <Plus size={13} weight="bold" /> New
            </button>
          </div>
          <div className="relative mx-3 mb-2">
            <MagnifyingGlass size={13} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-fg/40" />
            <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search chats" aria-label="Search chats" className="h-8 w-full rounded-lg border border-white/[0.06] bg-white/[0.025] pl-8 pr-2 font-sans text-[11px] text-fg outline-none placeholder:text-muted-fg/35 focus:border-accent/30" />
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {loading ? <div className="flex justify-center py-10 text-muted-fg/35"><SpinnerGap size={17} className="animate-spin" /></div> : null}
            {!loading && grouped.length === 0 ? <div className="px-4 py-10 text-center font-sans text-[11px] leading-5 text-muted-fg/40">No chats yet.<br />Start with anything on your mind.</div> : null}
            {grouped.map(([label, rows]) => (
              <div key={label} className="mb-3">
                <div className="px-2 pb-1 pt-2 font-mono text-[8px] font-semibold uppercase tracking-[0.14em] text-muted-fg/35">{label}</div>
                <div className="space-y-0.5">
                  {rows.map((session) => {
                    const active = session.sessionId === selectedId;
                    return (
                      <div key={session.sessionId} className="group relative">
                        <button type="button" onClick={() => setSelectedId(session.sessionId)} className={cn("flex w-full items-start gap-2.5 rounded-xl px-2.5 py-2.5 text-left transition-colors", active ? "bg-white/[0.075]" : "hover:bg-white/[0.04]")}>
                          <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-white/[0.06] bg-black/20"><ToolLogo toolType={providerToolType(session.provider)} size={15} /></span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-sans text-[12px] font-medium text-fg/82">{sessionTitle(session)}</span>
                            <span className="mt-0.5 block truncate font-sans text-[10px] text-muted-fg/42">{sessionPreview(session)}</span>
                          </span>
                          <span className="mt-0.5 shrink-0 font-mono text-[8px] text-muted-fg/30 group-hover:hidden">{relativeTime(session.lastActivityAt)}</span>
                        </button>
                        <button type="button" onClick={(event) => { event.stopPropagation(); setMenuId((current) => current === session.sessionId ? null : session.sessionId); }} className="absolute right-2 top-2 hidden h-6 w-6 items-center justify-center rounded-md text-muted-fg/45 hover:bg-white/[0.08] hover:text-fg group-hover:flex" aria-label={`More actions for ${sessionTitle(session)}`}><DotsThree size={15} weight="bold" /></button>
                        {menuId === session.sessionId ? (
                          <div className="absolute right-2 top-9 z-30 w-32 rounded-lg border border-white/[0.08] bg-[var(--color-popup-bg)] p-1 shadow-2xl">
                            <button type="button" onClick={() => void removeSession(session.sessionId, "archive")} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-fg/65 hover:bg-white/[0.06]"><Archive size={12} />Archive</button>
                            <button type="button" onClick={() => void removeSession(session.sessionId, "delete")} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[10px] text-rose-300/75 hover:bg-rose-500/10"><Trash size={12} />Delete</button>
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="relative min-w-0 flex-1">
        <ChatSurfaceShell
          mode="standard"
          accentColor={selectedDescriptor?.color ?? "#A78BFA"}
          chromeTint={chatChromeTint}
          shellGeometry={chatShellGeometry}
          header={(
            <div className="flex h-11 items-center gap-2 border-b border-white/[0.055] px-3">
              <button type="button" className="hidden h-7 w-7 items-center justify-center rounded-md text-muted-fg/55 hover:bg-white/[0.06] max-md:flex" onClick={() => setMobileListOpen(true)} aria-label="Show chats"><ArrowLeft size={15} /></button>
              <div className="min-w-0 flex-1 truncate font-sans text-[12px] font-medium text-fg/75">{selectedSession ? sessionTitle(selectedSession) : "New chat"}</div>
              {browserAvailable ? (
                <button type="button" onClick={() => setToolPanel((current) => current === "browser" ? null : "browser")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "browser" ? "border-sky-300/25 bg-sky-500/10 text-sky-200" : "border-white/[0.06] bg-white/[0.025] text-muted-fg/45 hover:text-fg")} title="Browser" aria-label="Toggle browser"><Globe size={14} /></button>
              ) : null}
              <button type="button" onClick={() => setToolPanel((current) => current === "terminal" ? null : "terminal")} className={cn("flex h-7 w-7 items-center justify-center rounded-md border transition-colors", toolPanel === "terminal" ? "border-violet-300/25 bg-violet-500/10 text-violet-200" : "border-white/[0.06] bg-white/[0.025] text-muted-fg/45 hover:text-fg")} title="Terminal" aria-label="Toggle terminal"><TerminalWindow size={14} /></button>
            </div>
          )}
          footer={(
            <div data-chat-appearance-root style={appearanceStyle} className="mx-auto w-full max-w-[860px]">
              {error ? <div role="alert" className="mb-1.5 flex items-start justify-between gap-2 rounded-lg border border-rose-400/15 bg-rose-500/[0.07] px-3 py-2 font-sans text-[10px] text-rose-200/70"><span>{error}</span><button type="button" onClick={() => setError(null)} aria-label="Dismiss error"><X size={12} /></button></div> : null}
              <div className="rounded-2xl border border-white/[0.09] bg-[color:var(--color-surface-raised)]/95 p-2 shadow-[0_24px_80px_-42px_rgba(0,0,0,0.9)] backdrop-blur-xl focus-within:border-accent/25">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void submit();
                    }
                  }}
                  rows={2}
                  autoFocus
                  placeholder="Message an ADE agent…"
                  aria-label="Message an ADE agent"
                  className="max-h-44 min-h-[54px] w-full resize-none bg-transparent px-2 py-1.5 font-sans text-[13px] leading-5 text-fg/88 outline-none placeholder:text-muted-fg/32"
                />
                <div className="flex min-w-0 items-center gap-1.5 pt-1">
                  <ModelPicker value={modelId} onChange={handleModelChange} surfaceKey="personal-chat" models={models} availableModelIds={availableModelIds} constrainToAvailableModelIds compact disabled={sending || turnActive || catalog === null || availableModelIds.length === 0} fastModeActive={fastMode} fastModeSupported={modelSupportsFastMode(selectedDescriptor)} onFastModeToggle={(next) => { setFastMode(next); void updateSelected({ fastMode: next }); }} />
                  <ReasoningEffortPicker modelId={modelId} reasoningEffort={reasoningEffort} compact disabled={sending || turnActive} onChange={(next) => { setReasoningEffort(next); void updateSelected({ reasoningEffort: next }); }} />
                  <select value={permissionMode} disabled={sending || turnActive} onChange={(event) => { const next = event.target.value as AgentChatPermissionMode; setPermissionMode(next); void updateSelected({ permissionMode: next }); }} className="h-7 max-w-[112px] rounded-md border border-white/[0.06] bg-white/[0.025] px-2 font-sans text-[10px] text-fg/60 outline-none" aria-label="Permission mode">
                    <option value="default">Default</option>
                    <option value="plan">Plan</option>
                    <option value="full-auto">Full access</option>
                  </select>
                  <div className="flex-1" />
                  {turnActive && selectedId ? (
                    <button type="button" onClick={() => void callPersonal<void>("interrupt", { sessionId: selectedId })} className="flex h-8 w-8 items-center justify-center rounded-full border border-rose-300/20 bg-rose-500/10 text-rose-200" aria-label="Stop response"><Stop size={13} weight="fill" /></button>
                  ) : (
                    <button type="button" disabled={!draft.trim() || sending || (!selectedSession && !hasValidNewSessionModel)} onClick={() => void submit()} className="flex h-8 w-8 items-center justify-center rounded-full bg-accent text-[var(--color-accent-contrast)] transition-opacity disabled:opacity-30" aria-label="Send message">{sending ? <SpinnerGap size={14} className="animate-spin" /> : <PaperPlaneTilt size={14} weight="fill" />}</button>
                  )}
                </div>
              </div>
              <div className="pt-1.5 text-center font-sans text-[9px] text-muted-fg/25">Projectless chat · agents have no project working directory</div>
            </div>
          )}
        >
          <div data-chat-appearance-root style={appearanceStyle} className="relative flex h-full min-h-0">
            <div className="min-w-0 flex-1">
              {selectedEvents.length ? (
                <AgentChatMessageList
                  events={selectedEvents}
                  showStreamingIndicator={turnActive}
                  laneId={null}
                  sessionId={selectedId}
                  assistantLabel={selectedSession ? sessionTitle(selectedSession) : "ADE"}
                  onApproval={(itemId, decision, responseText, answers) => {
                    if (!selectedId) return;
                    void callPersonal<void>("respondToInput", { sessionId: selectedId, itemId, decision, responseText, answers });
                  }}
                  onInsertDraft={(text) => setDraft((current) => current ? `${current}\n${text}` : text)}
                />
              ) : (
                <div className="flex h-full items-center justify-center overflow-y-auto px-6 py-10">
                  <div className="w-full max-w-[660px] text-center">
                    <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-2xl border border-accent/20 bg-accent/10 text-accent"><ChatCircleDots size={23} weight="duotone" /></span>
                    <h1 className="mt-4 font-sans text-[24px] font-semibold tracking-[-0.025em] text-fg/88">What can I help with?</h1>
                    <p className="mx-auto mt-2 max-w-[470px] font-sans text-[12px] leading-5 text-muted-fg/45">Think, write, research, plan, or work through an idea with any agent already connected to ADE.</p>
                    <div className="mt-6 grid grid-cols-2 gap-2 max-sm:grid-cols-1">
                      {["Help me think through a decision", "Draft something from a rough idea", "Research a topic with me", "Turn my notes into an action plan"].map((prompt) => (
                        <button key={prompt} type="button" onClick={() => setDraft(prompt)} className="rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-3 text-left font-sans text-[11px] leading-4 text-fg/55 transition-colors hover:border-accent/20 hover:bg-accent/[0.05] hover:text-fg/75">{prompt}</button>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
            {toolPanel === "browser" ? (
              <div className="w-[min(44%,560px)] min-w-[340px] border-l border-white/[0.07] bg-bg max-lg:absolute max-lg:inset-y-0 max-lg:right-0 max-lg:z-30 max-lg:w-[min(92%,560px)] max-lg:shadow-2xl">
                <ChatBuiltInBrowserPanel sessionId={selectedId} projectRootOverride={null} onInsertDraft={(text) => setDraft((current) => current ? `${current}\n${text}` : text)} />
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
