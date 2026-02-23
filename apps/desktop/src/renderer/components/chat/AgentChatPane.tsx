import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatCircle, ArrowsClockwise } from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatModelInfo,
  AgentChatProvider,
  AgentChatSessionSummary,
  ContextPackOption
} from "../../../shared/types";
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

const LAST_PROVIDER_KEY = "ade.chat.lastProvider";
const LAST_MODEL_KEY_PREFIX = "ade.chat.lastModel";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";

function defaultModel(provider: AgentChatProvider): string {
  return provider === "codex" ? "gpt-5.3-codex" : "sonnet";
}

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

function readLastUsedProvider(): AgentChatProvider | null {
  try {
    const raw = window.localStorage.getItem(LAST_PROVIDER_KEY);
    if (raw === "codex" || raw === "claude") return raw;
  } catch {
    // ignore
  }
  return null;
}

function writeLastUsedProvider(provider: AgentChatProvider) {
  try {
    window.localStorage.setItem(LAST_PROVIDER_KEY, provider);
  } catch {
    // ignore
  }
}

function readLastUsedModel(provider: AgentChatProvider): string | null {
  try {
    const raw = window.localStorage.getItem(`${LAST_MODEL_KEY_PREFIX}:${provider}`);
    return raw && raw.trim().length ? raw : null;
  } catch {
    return null;
  }
}

function writeLastUsedModel(provider: AgentChatProvider, model: string) {
  try {
    window.localStorage.setItem(`${LAST_MODEL_KEY_PREFIX}:${provider}`, model);
  } catch {
    // ignore
  }
}

function readLastUsedReasoningEffort(args: {
  laneId: string | null;
  provider: AgentChatProvider;
  model: string;
}): string | null {
  if (!args.laneId) return null;
  try {
    const raw = window.localStorage.getItem(`${LAST_REASONING_KEY_PREFIX}:${args.laneId}:${args.provider}:${args.model}`);
    return raw && raw.trim().length ? raw.trim() : null;
  } catch {
    return null;
  }
}

function writeLastUsedReasoningEffort(args: {
  laneId: string | null;
  provider: AgentChatProvider;
  model: string;
  effort: string | null;
}) {
  if (!args.laneId || !args.model.trim().length) return;
  try {
    const key = `${LAST_REASONING_KEY_PREFIX}:${args.laneId}:${args.provider}:${args.model}`;
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
  options: Array<{ effort: string; description: string }>;
  preferred: string | null;
}): string | null {
  if (!args.options.length) return null;
  if (args.preferred && args.options.some((entry) => entry.effort === args.preferred)) {
    return args.preferred;
  }
  return args.options.find((entry) => entry.effort === "medium")?.effort ?? args.options[0]!.effort;
}

function byStartedDesc(a: AgentChatSessionSummary, b: AgentChatSessionSummary): number {
  return Date.parse(b.startedAt) - Date.parse(a.startedAt);
}

function isChatToolType(toolType: string | null | undefined): boolean {
  return toolType === "codex-chat" || toolType === "claude-chat";
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
  const [provider, setProvider] = useState<AgentChatProvider>("codex");
  const [model, setModel] = useState<string>(defaultModel("codex"));
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [modelsByProvider, setModelsByProvider] = useState<Record<AgentChatProvider, AgentChatModelInfo[]>>({ codex: [], claude: [] });
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
  const activeModels = modelsByProvider[provider];
  const selectedModel = activeModels.find((entry) => entry.id === model) ?? activeModels[0] ?? null;
  const reasoningOptions = selectedModel?.reasoningEfforts ?? [];

  const refreshModels = useCallback(async (nextProvider: AgentChatProvider): Promise<AgentChatModelInfo[]> => {
    try {
      const models = await window.ade.agentChat.models({ provider: nextProvider });
      setModelsByProvider((prev) => ({ ...prev, [nextProvider]: models }));
      return models;
    } catch {
      setModelsByProvider((prev) => ({ ...prev, [nextProvider]: [] }));
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
    setProvider(selectedSession.provider);
    setModel(selectedSession.model);
    setReasoningEffort(selectedSession.reasoningEffort ?? null);
  }, [selectedSession?.sessionId]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      setLoading(true);
      try {
        const snapshot = await window.ade.projectConfig.get();
        const chat = snapshot.effective.ai?.chat;
        const configuredProvider = chat?.defaultProvider === "codex" || chat?.defaultProvider === "claude"
          ? chat.defaultProvider
          : chat?.defaultProvider === "last_used"
            ? (readLastUsedProvider() ?? "codex")
            : "codex";
        const configuredModel = readLastUsedModel(configuredProvider) ?? defaultModel(configuredProvider);
        if (!cancelled) {
          setProvider(configuredProvider);
          setModel(configuredModel);
          setSendOnEnter(chat?.sendOnEnter ?? true);
        }
      } catch {
        // fall back to defaults.
      }

      try {
        await Promise.all([refreshModels("codex"), refreshModels("claude"), refreshSessions()]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [refreshModels, refreshSessions]);

  useEffect(() => {
    if (loading) return;
    if (modelsByProvider[provider].length) return;
    const fallback = (["codex", "claude"] as AgentChatProvider[]).find((entry) => modelsByProvider[entry].length > 0);
    if (!fallback || fallback === provider) return;
    setProvider(fallback);
    const fallbackModel = readLastUsedModel(fallback);
    setModel(fallbackModel ?? (modelsByProvider[fallback][0]?.id ?? defaultModel(fallback)));
  }, [loading, modelsByProvider, provider]);

  useEffect(() => {
    const providerModels = modelsByProvider[provider];
    if (!providerModels.length) return;
    if (providerModels.some((entry) => entry.id === model)) return;
    const preferred = readLastUsedModel(provider);
    const defaultChoice = preferred && providerModels.some((entry) => entry.id === preferred)
      ? preferred
      : providerModels.find((entry) => entry.isDefault)?.id ?? providerModels[0]!.id;
    setModel(defaultChoice);
  }, [model, modelsByProvider, provider]);

  useEffect(() => {
    if (!reasoningOptions.length) {
      if (reasoningEffort !== null) setReasoningEffort(null);
      return;
    }

    if (reasoningEffort && reasoningOptions.some((entry) => entry.effort === reasoningEffort)) {
      return;
    }

    const preferred = readLastUsedReasoningEffort({
      laneId,
      provider,
      model
    });
    setReasoningEffort(selectReasoningEffort({ options: reasoningOptions, preferred }));
  }, [laneId, model, provider, reasoningEffort, reasoningOptions]);

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
    writeLastUsedProvider(provider);
  }, [provider]);

  useEffect(() => {
    if (!model.trim().length) return;
    writeLastUsedModel(provider, model);
  }, [provider, model]);

  useEffect(() => {
    writeLastUsedReasoningEffort({
      laneId,
      provider,
      model,
      effort: reasoningEffort
    });
  }, [laneId, model, provider, reasoningEffort]);

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
    const created = await window.ade.agentChat.create({
      laneId,
      provider,
      model,
      reasoningEffort
    });
    loadedHistoryRef.current.delete(created.id);
    setSelectedSessionId(created.id);
    await refreshSessions();
    return created.id;
  }, [laneId, model, provider, reasoningEffort, refreshSessions]);

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

  const providerOptions = useMemo(
    () => [
      {
        value: "codex" as const,
        label: "Codex",
        enabled: loading || modelsByProvider.codex.length > 0
      },
      {
        value: "claude" as const,
        label: "Claude",
        enabled: loading || modelsByProvider.claude.length > 0
      }
    ],
    [loading, modelsByProvider]
  );

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
            {sessions.map((session) => (
              <option key={session.sessionId} value={session.sessionId}>
                {session.provider} · {session.model} · {new Date(session.startedAt).toLocaleString()}
              </option>
            ))}
          </select>
        ) : (
          <div className="min-w-[220px] flex-1 text-xs text-muted-fg">
            {selectedSession ? `${selectedSession.provider} · ${selectedSession.model}` : lockSessionId}
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
            <Chip className="text-[11px]">{selectedSession.provider}</Chip>
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
            description="Create a new chat session or choose an existing one to start working with Codex or Claude."
          />
        )}
      </div>

      <AgentChatComposer
        provider={provider}
        providerOptions={providerOptions}
        model={model}
        models={activeModels.length ? activeModels : [{ id: defaultModel(provider), displayName: defaultModel(provider), isDefault: true }]}
        reasoningEffort={reasoningEffort}
        draft={draft}
        attachments={attachments}
        pendingApproval={pendingApproval}
        turnActive={turnActive}
        sendOnEnter={sendOnEnter}
        busy={busy}
        selectedContextPacks={selectedContextPacks}
        laneId={laneId ?? undefined}
        onProviderChange={(nextProvider) => {
          setProvider(nextProvider);
          if (!modelsByProvider[nextProvider].length) {
            void refreshModels(nextProvider);
          }
          const providerModels = modelsByProvider[nextProvider];
          const preferredModel = readLastUsedModel(nextProvider);
          const nextModel = preferredModel && providerModels.some((entry) => entry.id === preferredModel)
            ? preferredModel
            : providerModels.find((entry) => entry.isDefault)?.id
              ?? providerModels[0]?.id
              ?? defaultModel(nextProvider);
          setModel(nextModel);

          const options = (providerModels.find((entry) => entry.id === nextModel)?.reasoningEfforts ?? []);
          const preferredReasoning = readLastUsedReasoningEffort({
            laneId,
            provider: nextProvider,
            model: nextModel
          });
          setReasoningEffort(selectReasoningEffort({ options, preferred: preferredReasoning }));
        }}
        onModelChange={(nextModel) => {
          setModel(nextModel);
          const options = (modelsByProvider[provider].find((entry) => entry.id === nextModel)?.reasoningEfforts ?? []);
          const preferred = readLastUsedReasoningEffort({
            laneId,
            provider,
            model: nextModel
          });
          setReasoningEffort(selectReasoningEffort({ options, preferred }));
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
