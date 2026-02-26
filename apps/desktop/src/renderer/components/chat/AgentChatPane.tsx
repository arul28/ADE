import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatCircle, ArrowsClockwise } from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatSessionSummary,
  ContextPackOption
} from "../../../shared/types";
import { MODEL_REGISTRY, getModelById } from "../../../shared/modelRegistry";
import { Button } from "../ui/Button";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { AgentChatComposer } from "./AgentChatComposer";
import { AgentChatMessageList } from "./AgentChatMessageList";

type PendingApproval = {
  itemId: string;
  description: string;
  kind: "command" | "file_change" | "tool_call";
};

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";

// Migration: old localStorage keys for backward compatibility
const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

const DEFAULT_MODEL_ID = "anthropic/claude-sonnet-4-6";

function parseChatTranscript(raw: string): AgentChatEventEnvelope[] {
  const out: AgentChatEventEnvelope[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.length) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (!parsed || typeof parsed !== "object") continue;
      const record = parsed as Partial<AgentChatEventEnvelope>;
      const sessionId = typeof record.sessionId === "string" ? record.sessionId : "";
      const timestamp = typeof record.timestamp === "string" ? record.timestamp : new Date().toISOString();
      const event = record.event as AgentChatEvent | undefined;
      if (!sessionId || !event || typeof event !== "object") continue;
      out.push({ sessionId, timestamp, event });
    } catch {
      // Ignore malformed lines.
    }
  }
  return out;
}

function deriveRuntimeState(events: AgentChatEventEnvelope[]): {
  turnActive: boolean;
  pendingApprovals: PendingApproval[];
} {
  let turnActive = false;
  const pending = new Map<string, PendingApproval>();

  for (const envelope of events) {
    const event = envelope.event;

    if (event.type === "status") {
      if (event.turnStatus === "started") turnActive = true;
      if (event.turnStatus === "completed" || event.turnStatus === "interrupted" || event.turnStatus === "failed") {
        turnActive = false;
      }
      continue;
    }

    if (event.type === "done") {
      turnActive = false;
      pending.clear();
      continue;
    }

    if (event.type === "approval_request") {
      pending.set(event.itemId, {
        itemId: event.itemId,
        description: event.description,
        kind: event.kind
      });
      continue;
    }

    if (event.type === "tool_result" || event.type === "command" || event.type === "file_change") {
      pending.delete(event.itemId);
    }
  }

  return {
    turnActive,
    pendingApprovals: [...pending.values()]
  };
}

/** Migrate old provider+model localStorage to unified modelId. */
function migrateOldPrefs(): string | null {
  try {
    const oldProvider = window.localStorage.getItem(LEGACY_PROVIDER_KEY);
    const oldModel = oldProvider ? window.localStorage.getItem(`${LEGACY_MODEL_KEY_PREFIX}:${oldProvider}`) : null;
    if (oldProvider && oldModel) {
      // Try to map old model shortIds to new full IDs
      const match = MODEL_REGISTRY.find((m) => m.shortId === oldModel || m.sdkModelId === oldModel);
      if (match) {
        window.localStorage.setItem(LAST_MODEL_ID_KEY, match.id);
        // Clean up legacy keys
        window.localStorage.removeItem(LEGACY_PROVIDER_KEY);
        window.localStorage.removeItem(`${LEGACY_MODEL_KEY_PREFIX}:codex`);
        window.localStorage.removeItem(`${LEGACY_MODEL_KEY_PREFIX}:claude`);
        return match.id;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function readLastUsedModelId(): string | null {
  try {
    const raw = window.localStorage.getItem(LAST_MODEL_ID_KEY);
    if (raw && raw.trim().length) return raw.trim();
  } catch {
    // ignore
  }
  return migrateOldPrefs();
}

function writeLastUsedModelId(modelId: string) {
  try {
    window.localStorage.setItem(LAST_MODEL_ID_KEY, modelId);
  } catch {
    // ignore
  }
}

function readLastUsedReasoningEffort(args: {
  laneId: string | null;
  modelId: string;
}): string | null {
  if (!args.laneId) return null;
  try {
    const raw = window.localStorage.getItem(`${LAST_REASONING_KEY_PREFIX}:${args.laneId}:${args.modelId}`);
    return raw && raw.trim().length ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeLastUsedReasoningEffort(args: {
  laneId: string | null;
  modelId: string;
  effort: string | null;
}) {
  if (!args.laneId || !args.modelId.trim().length) return;
  try {
    const key = `${LAST_REASONING_KEY_PREFIX}:${args.laneId}:${args.modelId}`;
    if (!args.effort || !args.effort.trim().length) {
      window.localStorage.removeItem(key);
      return;
    }
    window.localStorage.setItem(key, args.effort.trim());
  } catch {
    // ignore
  }
}

function selectReasoningEffort(args: {
  tiers: string[];
  preferred: string | null;
}): string | null {
  if (!args.tiers.length) return null;
  if (args.preferred && args.tiers.includes(args.preferred)) {
    return args.preferred;
  }
  return args.tiers.includes("medium") ? "medium" : args.tiers[0]!;
}

function byStartedDesc(a: AgentChatSessionSummary, b: AgentChatSessionSummary): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat" || toolType === "ai-chat";
}

function inferAttachmentType(filePath: string): AgentChatFileRef["type"] {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(filePath) ? "image" : "file";
}

export function AgentChatPane({
  laneId,
  initialSessionId,
  lockSessionId
}: {
  laneId: string | null;
  initialSessionId?: string | null;
  lockSessionId?: string | null;
}) {
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(lockSessionId ?? initialSessionId ?? null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [turnActiveBySession, setTurnActiveBySession] = useState<Record<string, boolean>>({});
  const [approvalsBySession, setApprovalsBySession] = useState<Record<string, PendingApproval[]>>({});
  const [modelId, setModelId] = useState<string>(DEFAULT_MODEL_ID);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [selectedContextPacks, setSelectedContextPacks] = useState<ContextPackOption[]>([]);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadedHistoryRef = useRef<Set<string>>(new Set());

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.sessionId === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId]
  );

  const selectedEvents = selectedSessionId ? eventsBySession[selectedSessionId] ?? [] : [];
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;
  const pendingApproval = selectedSessionId ? (approvalsBySession[selectedSessionId]?.[0] ?? null) : null;
  const selectedModelDesc = getModelById(modelId);
  const reasoningTiers = selectedModelDesc?.reasoningTiers ?? [];

  const refreshAvailableModels = useCallback(async () => {
    try {
      // Fetch available model lists from both providers for backward compat
      const [codexModels, claudeModels] = await Promise.all([
        window.ade.agentChat.models({ provider: "codex" }).catch(() => []),
        window.ade.agentChat.models({ provider: "claude" }).catch(() => []),
      ]);
      // Build available model IDs from the registry, including all models whose
      // family has at least one model available from the backend
      const hasCodex = codexModels.length > 0;
      const hasClaude = claudeModels.length > 0;
      const available = MODEL_REGISTRY.filter((m) => {
        if (m.deprecated) return false;
        if (m.family === "openai" && hasCodex) return true;
        if (m.family === "anthropic" && hasClaude) return true;
        // API-key and other models are always available
        if (!m.isCliWrapped) return true;
        return false;
      }).map((m) => m.id);
      setAvailableModelIds(available);
      return available;
    } catch {
      setAvailableModelIds([]);
      return [];
    }
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!laneId) {
      setSessions([]);
      return;
    }

    const rows = await window.ade.agentChat.list({ laneId });
    rows.sort(byStartedDesc);
    setSessions(rows);

    const pinned = lockSessionId ?? initialSessionId ?? null;
    if (pinned) {
      setSelectedSessionId(pinned);
      return;
    }

    setSelectedSessionId((current) => {
      if (current && rows.some((row) => row.sessionId === current)) return current;
      return rows[0]?.sessionId ?? null;
    });
  }, [initialSessionId, laneId, lockSessionId]);

  const loadHistory = useCallback(async (sessionId: string) => {
    if (loadedHistoryRef.current.has(sessionId)) return;
    loadedHistoryRef.current.add(sessionId);

    try {
      const summary = await window.ade.sessions.get(sessionId);
      if (!summary || !isChatToolType(summary.toolType)) return;
      const raw = await window.ade.sessions.readTranscriptTail({
        sessionId,
        maxBytes: 1_800_000,
        raw: true
      });
      const parsed = parseChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);
      const derived = deriveRuntimeState(parsed);
      setEventsBySession((prev) => ({ ...prev, [sessionId]: parsed }));
      setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: derived.turnActive }));
      setApprovalsBySession((prev) => ({ ...prev, [sessionId]: derived.pendingApprovals }));
    } catch {
      // Ignore transcript history failures.
    }
  }, []);

  useEffect(() => {
    if (lockSessionId) {
      setSelectedSessionId(lockSessionId);
    }
  }, [lockSessionId]);

  useEffect(() => {
    if (!selectedSession) return;
    // Prefer the unified modelId if present, otherwise reconstruct from provider+model
    const sessionModelId = selectedSession.modelId
      ?? MODEL_REGISTRY.find((m) => m.shortId === selectedSession.model || m.sdkModelId === selectedSession.model)?.id
      ?? modelId;
    setModelId(sessionModelId);
    setReasoningEffort(selectedSession.reasoningEffort ?? null);
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      setLoading(true);
      try {
        const snapshot = await window.ade.projectConfig.get();
        const chat = snapshot.effective.ai?.chat;
        const savedModelId = readLastUsedModelId();
        if (!cancelled) {
          setModelId(savedModelId ?? DEFAULT_MODEL_ID);
          setSendOnEnter(chat?.sendOnEnter ?? true);
        }
      } catch {
        // fall back to defaults.
      }

      try {
        await Promise.all([refreshAvailableModels(), refreshSessions()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [refreshAvailableModels, refreshSessions]);

  // If the selected model is not in the available list, fall back
  useEffect(() => {
    if (loading || !availableModelIds.length) return;
    if (availableModelIds.includes(modelId)) return;
    const preferred = readLastUsedModelId();
    if (preferred && availableModelIds.includes(preferred)) {
      setModelId(preferred);
    } else {
      setModelId(availableModelIds[0]!);
    }
  }, [loading, availableModelIds, modelId]);

  // Sync reasoning effort when model changes
  useEffect(() => {
    if (!reasoningTiers.length) {
      if (reasoningEffort !== null) setReasoningEffort(null);
      return;
    }
    if (reasoningEffort && reasoningTiers.includes(reasoningEffort)) return;
    const preferred = readLastUsedReasoningEffort({ laneId, modelId });
    setReasoningEffort(selectReasoningEffort({ tiers: reasoningTiers, preferred }));
  }, [laneId, modelId, reasoningEffort, reasoningTiers]);

  useEffect(() => {
    if (!selectedSessionId) return;
    void loadHistory(selectedSessionId);
  }, [loadHistory, selectedSessionId]);

  useEffect(() => {
    setAttachments([]);
  }, [selectedSessionId]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      setEventsBySession((prev) => {
        const sessionEvents = [...(prev[envelope.sessionId] ?? []), envelope];
        const derived = deriveRuntimeState(sessionEvents);
        setTurnActiveBySession((activePrev) => ({ ...activePrev, [envelope.sessionId]: derived.turnActive }));
        setApprovalsBySession((approvalPrev) => ({ ...approvalPrev, [envelope.sessionId]: derived.pendingApprovals }));
        return {
          ...prev,
          [envelope.sessionId]: sessionEvents
        };
      });

      if (lockSessionId && envelope.sessionId === lockSessionId) {
        setSelectedSessionId(lockSessionId);
      }

      if (envelope.event.type === "done" || (envelope.event.type === "status" && envelope.event.turnStatus !== "started")) {
        void refreshSessions().catch(() => {});
      }
    });
    return unsubscribe;
  }, [lockSessionId, refreshSessions]);

  useEffect(() => {
    if (!modelId.trim().length) return;
    writeLastUsedModelId(modelId);
  }, [modelId]);

  useEffect(() => {
    writeLastUsedReasoningEffort({
      laneId,
      modelId,
      effort: reasoningEffort
    });
  }, [laneId, modelId, reasoningEffort]);

  const searchAttachments = useCallback(async (query: string): Promise<AgentChatFileRef[]> => {
    if (!laneId) return [];
    const trimmed = query.trim();
    if (!trimmed.length) return [];
    const hits = await window.ade.files.quickOpen({
      workspaceId: laneId,
      query: trimmed,
      limit: 60
    });
    return hits.map((hit) => ({
      path: hit.path,
      type: inferAttachmentType(hit.path)
    }));
  }, [laneId]);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    setAttachments((prev) => {
      if (prev.some((entry) => entry.path === attachment.path)) return prev;
      return [...prev, attachment];
    });
  }, []);

  const removeAttachment = useCallback((attachmentPath: string) => {
    setAttachments((prev) => prev.filter((entry) => entry.path !== attachmentPath));
  }, []);

  const createSession = useCallback(async (): Promise<string | null> => {
    if (!laneId) return null;
    const desc = getModelById(modelId);
    // Derive provider from the model family for backward compatibility with the backend
    const provider = desc?.family === "openai" ? "codex" : "claude";
    const model = desc?.shortId ?? modelId;
    const created = await window.ade.agentChat.create({
      laneId,
      provider,
      model,
      modelId,
      reasoningEffort
    });
    loadedHistoryRef.current.delete(created.id);
    setSelectedSessionId(created.id);
    await refreshSessions();
    return created.id;
  }, [laneId, modelId, reasoningEffort, refreshSessions]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text.length || !laneId) return;

    setBusy(true);
    setError(null);
    try {
      // Fetch context packs and prepend their content
      let finalText = text;
      if (selectedContextPacks.length) {
        const packContents: string[] = [];
        for (const pack of selectedContextPacks) {
          try {
            const result = await window.ade.agentChat.fetchContextPack({
              scope: pack.scope,
              laneId: laneId ?? undefined,
              featureKey: pack.featureKey,
              missionId: pack.missionId
            });
            if (result.content.trim().length) {
              packContents.push(`[Context: ${pack.label}]\n${result.content}`);
            }
          } catch {
            // Skip packs that fail to fetch
          }
        }
        if (packContents.length) {
          finalText = `${packContents.join("\n\n")}\n\n---\n\n${text}`;
        }
      }

      let sessionId = selectedSessionId;
      if (!sessionId) {
        sessionId = await createSession();
      }
      if (!sessionId) {
        throw new Error("Unable to create chat session.");
      }

      const selectedAttachments = attachments;
      if (turnActiveBySession[sessionId]) {
        const steerText = selectedAttachments.length
          ? `${finalText}\n\nAttached context:\n${selectedAttachments.map((entry) => `- ${entry.type}: ${entry.path}`).join("\n")}`
          : finalText;
        await window.ade.agentChat.steer({ sessionId, text: steerText });
      } else {
        await window.ade.agentChat.send({
          sessionId,
          text: finalText,
          attachments: selectedAttachments,
          reasoningEffort
        });
      }
      setDraft("");
      setAttachments([]);
      setSelectedContextPacks([]);
      await refreshSessions();
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      setBusy(false);
    }
  }, [attachments, createSession, draft, laneId, reasoningEffort, refreshSessions, selectedContextPacks, selectedSessionId, turnActiveBySession]);

  const interrupt = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      await window.ade.agentChat.interrupt({ sessionId: selectedSessionId });
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError));
    }
  }, [selectedSessionId]);

  const approve = useCallback(async (decision: AgentChatApprovalDecision) => {
    if (!selectedSessionId) return;
    const approval = approvalsBySession[selectedSessionId]?.[0];
    if (!approval) return;
    try {
      await window.ade.agentChat.approve({
        sessionId: selectedSessionId,
        itemId: approval.itemId,
        decision
      });
      setApprovalsBySession((prev) => ({
        ...prev,
        [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((entry) => entry.itemId !== approval.itemId)
      }));
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    }
  }, [approvalsBySession, selectedSessionId]);

  if (!laneId) {
    return <EmptyState title="No lane selected" description="Select a lane to use agent chat." />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/35 bg-card/70 px-2.5 py-2 shadow-[0_1px_0_rgba(255,255,255,0.03)]">
        <div className="text-xs font-semibold tracking-wide text-fg/85">Agent Chat</div>

        {!lockSessionId ? (
          <select
            value={selectedSessionId ?? ""}
            onChange={(event) => setSelectedSessionId(event.target.value || null)}
            className="h-7 min-w-[220px] flex-1 rounded border border-border/40 bg-bg/65 px-2 text-xs"
          >
            <option value="">No session selected</option>
            {sessions.map((session) => {
              const desc = session.modelId ? getModelById(session.modelId) : MODEL_REGISTRY.find((m) => m.shortId === session.model);
              const label = desc?.displayName ?? `${session.provider}/${session.model}`;
              return (
                <option key={session.sessionId} value={session.sessionId}>
                  {label} · {new Date(session.startedAt).toLocaleString()}
                </option>
              );
            })}
          </select>
        ) : (
          <div className="min-w-[220px] flex-1 text-xs text-muted-fg">
            {selectedSession
              ? (getModelById(selectedSession.modelId ?? "")?.displayName ?? `${selectedSession.provider}/${selectedSession.model}`)
              : lockSessionId}
          </div>
        )}

        {!lockSessionId ? (
          <Button
            size="sm"
            variant="outline"
            className="h-7 px-2 text-[11px]"
            onClick={() => {
              setBusy(true);
              setError(null);
              createSession()
                .catch((createError) => {
                  setError(createError instanceof Error ? createError.message : String(createError));
                })
                .finally(() => setBusy(false));
            }}
          >
            <ChatCircle size={14} weight="regular" />
            New chat
          </Button>
        ) : null}

        <Button
          size="sm"
          variant="outline"
          className="h-7 px-2 text-[11px]"
          onClick={() => {
            setError(null);
            refreshSessions().catch((refreshError) => {
              setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
            });
          }}
        >
          <ArrowsClockwise size={14} weight="regular" />
          Refresh
        </Button>

        {selectedSession ? (
          <>
            <Chip className="text-[11px]">{getModelById(selectedSession.modelId ?? "")?.displayName ?? selectedSession.model}</Chip>
            <Chip className="text-[11px]">{selectedSession.status}</Chip>
            {turnActive ? <Chip className="bg-accent/20 text-[10px] text-fg/90">active turn</Chip> : null}
          </>
        ) : null}
      </div>

      {error ? <div className="rounded border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-xs text-fg/90">{error}</div> : null}

      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center text-xs text-muted-fg">Loading chat sessions...</div>
        ) : selectedSessionId ? (
          <AgentChatMessageList events={selectedEvents} showStreamingIndicator={turnActive} />
        ) : (
          <EmptyState
            title="No chat session"
            description="Create a new chat session or choose an existing one to start working with an AI agent."
          />
        )}
      </div>

      <AgentChatComposer
        modelId={modelId}
        availableModelIds={availableModelIds.length ? availableModelIds : undefined}
        reasoningEffort={reasoningEffort}
        draft={draft}
        attachments={attachments}
        pendingApproval={pendingApproval}
        turnActive={turnActive}
        sendOnEnter={sendOnEnter}
        busy={busy}
        selectedContextPacks={selectedContextPacks}
        laneId={laneId ?? undefined}
        onModelChange={(nextModelId) => {
          setModelId(nextModelId);
          const nextDesc = getModelById(nextModelId);
          const tiers = nextDesc?.reasoningTiers ?? [];
          const preferred = readLastUsedReasoningEffort({ laneId, modelId: nextModelId });
          setReasoningEffort(selectReasoningEffort({ tiers, preferred }));
        }}
        onReasoningEffortChange={setReasoningEffort}
        onDraftChange={setDraft}
        onSubmit={() => {
          void submit();
        }}
        onInterrupt={() => {
          void interrupt();
        }}
        onApproval={(decision) => {
          void approve(decision);
        }}
        onAddAttachment={addAttachment}
        onRemoveAttachment={removeAttachment}
        onSearchAttachments={searchAttachments}
        onContextPacksChange={setSelectedContextPacks}
        onClearEvents={() => {
          if (selectedSessionId) {
            setEventsBySession((prev) => ({ ...prev, [selectedSessionId]: [] }));
          }
        }}
      />
    </div>
  );
}
