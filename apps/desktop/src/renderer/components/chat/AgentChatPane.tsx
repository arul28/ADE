import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChatCircle, ArrowsClockwise, Plus } from "@phosphor-icons/react";
import type {
  AgentChatApprovalDecision,
  AiDetectedAuth,
  AgentChatEvent,
  AgentChatEventEnvelope,
  AgentChatFileRef,
  AgentChatPermissionMode,
  AgentChatSessionSummary,
  ContextPackOption
} from "../../../shared/types";
import { MODEL_REGISTRY, getModelById, type ModelDescriptor } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { AgentChatComposer } from "./AgentChatComposer";
import { AgentChatMessageList } from "./AgentChatMessageList";
import { AgentQuestionModal } from "./AgentQuestionModal";
import { isChatToolType } from "../../lib/sessions";
import { ToolLogo } from "../terminals/ToolLogos";

type PendingApproval = {
  itemId: string;
  description: string;
  kind: "command" | "file_change" | "tool_call";
  detail?: unknown;
};

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";

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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractAskUserQuestion(approval: PendingApproval | null): string | null {
  if (!approval || approval.kind !== "tool_call") return null;
  const detail = readRecord(approval.detail);
  const tool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
  const question = typeof detail?.question === "string" ? detail.question.trim() : "";
  if (tool !== "askUser" || !question.length) return null;
  return question;
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
        kind: event.kind,
        detail: event.detail,
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

function migrateOldPrefs(): string | null {
  try {
    const oldProvider = window.localStorage.getItem(LEGACY_PROVIDER_KEY);
    const oldModel = oldProvider ? window.localStorage.getItem(`${LEGACY_MODEL_KEY_PREFIX}:${oldProvider}`) : null;
    if (oldProvider && oldModel) {
      const match = MODEL_REGISTRY.find((m) => m.shortId === oldModel || m.sdkModelId === oldModel);
      if (match) {
        window.localStorage.setItem(LAST_MODEL_ID_KEY, match.id);
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

function inferAttachmentType(filePath: string): AgentChatFileRef["type"] {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i.test(filePath) ? "image" : "file";
}

function resolveRegistryModelId(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.id.toLowerCase() === normalized
      || model.shortId.toLowerCase() === normalized
      || model.sdkModelId.toLowerCase() === normalized
  );
  return match?.id ?? null;
}

function resolveCliRegistryModelId(provider: "codex" | "claude", value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  const family = provider === "codex" ? "openai" : "anthropic";
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.isCliWrapped
      && model.family === family
      && (
        model.id.toLowerCase() === normalized
        || model.shortId.toLowerCase() === normalized
        || model.sdkModelId.toLowerCase() === normalized
      )
  );
  return match?.id ?? null;
}

function chatToolTypeForProvider(provider: string | null | undefined): "codex-chat" | "claude-chat" | "ai-chat" {
  if (provider === "codex") return "codex-chat";
  if (provider === "claude") return "claude-chat";
  return "ai-chat";
}

function normalizeChatLabel(raw: string | null | undefined): string | null {
  const normalized = String(raw ?? "").replace(/\s+/g, " ").trim();
  return normalized.length ? normalized : null;
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
  if (collapsed.includes("ai apicallerror")) return true;

  if (/^(session closed|chat completed)\b/u.test(collapsed)) {
    return true;
  }

  if (/^(completed?|done|finished|resolved|success)\b/u.test(collapsed)) {
    const remainder = collapsed.replace(/^(completed?|done|finished|resolved|success)\b/u, "").trim();
    const remainderTokens = remainder.length ? remainder.split(/\s+/).filter(Boolean) : [];
    const genericRemainder = remainderTokens.every((token) =>
      /^(ok|okay|ready|hello|hi|test|yes|no|true|false|response|reply|result|output|pass|passed)$/u.test(token)
    );
    return !remainderTokens.length || remainderTokens.length <= 2 || genericRemainder;
  }

  return false;
}

function preferredChatLabel(raw: string | null | undefined): string | null {
  const normalized = normalizeChatLabel(raw);
  if (!normalized || isLowSignalChatLabel(normalized)) return null;
  return normalized;
}

function chatSessionTitle(session: AgentChatSessionSummary): string {
  const explicitTitle = preferredChatLabel(session.title);
  if (explicitTitle) return explicitTitle;

  const explicitGoal = preferredChatLabel(session.goal);
  if (explicitGoal) return explicitGoal;

  const summary = preferredChatLabel(session.summary);
  if (summary) return summary;

  const descriptor = session.modelId ? getModelById(session.modelId) : null;
  return descriptor?.displayName ?? `${session.provider}/${session.model}`;
}

function hasConfiguredNonCliAuth(model: ModelDescriptor, detectedAuth: AiDetectedAuth[]): boolean {
  return model.authTypes.some((authType) => {
    if (authType === "api-key") {
      return detectedAuth.some((auth) => auth.type === "api-key" && auth.provider === model.family);
    }
    if (authType === "openrouter") {
      return detectedAuth.some((auth) => auth.type === "openrouter");
    }
    if (authType === "local") {
      if (model.family === "ollama" || model.family === "lmstudio" || model.family === "vllm") {
        return detectedAuth.some((auth) => auth.type === "local" && auth.provider === model.family);
      }
      return detectedAuth.some((auth) => auth.type === "local");
    }
    return false;
  });
}

function deriveConfiguredModelIdsFromStatus(status: {
  availableProviders: { codex: boolean; claude: boolean };
  models: { codex: Array<{ id: string }>; claude: Array<{ id: string }> };
  detectedAuth?: AiDetectedAuth[];
  availableModelIds?: string[];
}): string[] {
  const available = new Set<string>();

  for (const modelId of status.availableModelIds ?? []) {
    const normalized = String(modelId ?? "").trim();
    if (!normalized.length) continue;
    const descriptor = getModelById(normalized);
    if (descriptor && !descriptor.deprecated) {
      available.add(descriptor.id);
    }
  }

  if (status.availableProviders.codex) {
    for (const model of status.models.codex ?? []) {
      const resolved = resolveCliRegistryModelId("codex", model.id);
      if (resolved) available.add(resolved);
    }
  }

  if (status.availableProviders.claude) {
    for (const model of status.models.claude ?? []) {
      const resolved = resolveCliRegistryModelId("claude", model.id);
      if (resolved) available.add(resolved);
    }
  }

  const detectedAuth = status.detectedAuth ?? [];
  if (!available.size && detectedAuth.length) {
    for (const model of MODEL_REGISTRY) {
      if (model.deprecated || model.isCliWrapped) continue;
      if (hasConfiguredNonCliAuth(model, detectedAuth)) {
        available.add(model.id);
      }
    }
  }

  return [...available];
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
  const [permissionMode, setPermissionMode] = useState<AgentChatPermissionMode>("plan");
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [selectedContextPacks, setSelectedContextPacks] = useState<ContextPackOption[]>([]);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const appliedInitialSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());
  const draftSelectionLockedRef = useRef(false);
  const optimisticSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingEventQueueRef = useRef<AgentChatEventEnvelope[]>([]);
  const eventFlushTimerRef = useRef<number | null>(null);
  const refreshSessionsTimerRef = useRef<number | null>(null);

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.sessionId === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId]
  );
  const selectedSessionModelId = useMemo(() => {
    if (!selectedSession) return null;
    return selectedSession.modelId ?? resolveRegistryModelId(selectedSession.model);
  }, [selectedSession]);

  const selectedEvents = selectedSessionId ? eventsBySession[selectedSessionId] ?? [] : [];
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;
  const pendingApproval = selectedSessionId ? (approvalsBySession[selectedSessionId]?.[0] ?? null) : null;
  const pendingQuestion = useMemo(() => extractAskUserQuestion(pendingApproval), [pendingApproval]);
  const selectedModelDesc = getModelById(modelId);
  const reasoningTiers = selectedModelDesc?.reasoningTiers ?? [];

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) return;
    const nextModelId = session.modelId ?? resolveRegistryModelId(session.model);
    if (nextModelId) {
      setModelId(nextModelId);
    }
    setReasoningEffort(session.reasoningEffort ?? null);
    if (session.permissionMode) {
      setPermissionMode(session.permissionMode);
    }
  }, []);

  const modelSelectionDiffersFromSession = Boolean(selectedSession && selectedSessionModelId && selectedSessionModelId !== modelId);

  const sessionProvider = useMemo(() => {
    if (selectedSession && !modelSelectionDiffersFromSession) return selectedSession.provider;
    const desc = getModelById(modelId);
    if (!desc) return "unified";
    if (desc.family === "openai" && desc.isCliWrapped) return "codex";
    if (desc.family === "anthropic" && desc.isCliWrapped) return "claude";
    return "unified";
  }, [selectedSession, modelSelectionDiffersFromSession, modelId]);

  const sessionIsCliWrapped = useMemo(() => {
    if (selectedSessionModelId && !modelSelectionDiffersFromSession) {
      const desc = getModelById(selectedSessionModelId);
      return desc?.isCliWrapped ?? false;
    }
    return selectedModelDesc?.isCliWrapped ?? false;
  }, [selectedSessionModelId, modelSelectionDiffersFromSession, selectedModelDesc]);

  // Keep all configured models selectable, and always include the active session model.
  const effectiveAvailableModelIds = useMemo(() => {
    if (!selectedSessionModelId) return availableModelIds;
    return availableModelIds.includes(selectedSessionModelId)
      ? availableModelIds
      : [selectedSessionModelId, ...availableModelIds];
  }, [availableModelIds, selectedSessionModelId]);

  const refreshAvailableModels = useCallback(async () => {
    try {
      const status = await window.ade.ai.getStatus();
      const available = deriveConfiguredModelIdsFromStatus(status);
      setAvailableModelIds(available);
      return available;
    } catch {
      // Fall back to direct model discovery probes below.
    }

    try {
      const [codexModels, claudeModels, unifiedModels] = await Promise.all([
        window.ade.agentChat.models({ provider: "codex" }).catch(() => []),
        window.ade.agentChat.models({ provider: "claude" }).catch(() => []),
        window.ade.agentChat.models({ provider: "unified" }).catch(() => []),
      ]);
      const available = new Set<string>();

      for (const model of codexModels) {
        const resolved = resolveCliRegistryModelId("codex", model.id);
        if (resolved) available.add(resolved);
      }
      for (const model of claudeModels) {
        const resolved = resolveCliRegistryModelId("claude", model.id);
        if (resolved) available.add(resolved);
      }
      for (const model of unifiedModels) {
        const resolved = resolveRegistryModelId(model.id);
        if (resolved) available.add(resolved);
      }

      const ordered = MODEL_REGISTRY.filter((model) => !model.deprecated && available.has(model.id)).map((model) => model.id);
      setAvailableModelIds(ordered);
      return ordered;
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
    for (const row of rows) {
      optimisticSessionIdsRef.current.delete(row.sessionId);
    }

    if (lockSessionId) {
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(lockSessionId);
      return;
    }

    setSelectedSessionId((current) => {
      if (!current && draftSelectionLockedRef.current) return null;
      if (current && rows.some((row) => row.sessionId === current)) return current;
      if (current && optimisticSessionIdsRef.current.has(current)) return current;
      return rows[0]?.sessionId ?? null;
    });
  }, [laneId, lockSessionId]);

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
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(lockSessionId);
    }
  }, [lockSessionId]);

  useEffect(() => {
    const nextInitialSessionId = initialSessionId ?? null;
    if (!nextInitialSessionId) {
      appliedInitialSessionIdRef.current = null;
      return;
    }
    if (lockSessionId) return;
    if (appliedInitialSessionIdRef.current === nextInitialSessionId) return;
    appliedInitialSessionIdRef.current = nextInitialSessionId;
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(nextInitialSessionId);
  }, [initialSessionId, lockSessionId]);

  useEffect(() => {
    draftSelectionLockedRef.current = false;
    optimisticSessionIdsRef.current.clear();
    appliedInitialSessionIdRef.current = initialSessionId ?? null;
  }, [laneId]);

  useEffect(() => {
    syncComposerToSession(selectedSession);
  }, [selectedSession?.sessionId, selectedSessionModelId, syncComposerToSession]);

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

  const flushQueuedEvents = useCallback(() => {
    const queued = pendingEventQueueRef.current;
    if (!queued.length) return;
    pendingEventQueueRef.current = [];

    setEventsBySession((prev) => {
      let next = prev;
      const touchedSessionIds = new Set<string>();

      for (const envelope of queued) {
        const sessionId = envelope.sessionId;
        const sessionEvents = next === prev ? (prev[sessionId] ?? []) : (next[sessionId] ?? []);
        const updated = [...sessionEvents, envelope];
        if (next === prev) {
          next = { ...prev };
        }
        next[sessionId] = updated;
        touchedSessionIds.add(sessionId);
      }

      if (!touchedSessionIds.size) return prev;

      const activePatch: Record<string, boolean> = {};
      const approvalPatch: Record<string, PendingApproval[]> = {};
      for (const sessionId of touchedSessionIds) {
        const derived = deriveRuntimeState(next[sessionId] ?? []);
        activePatch[sessionId] = derived.turnActive;
        approvalPatch[sessionId] = derived.pendingApprovals;
      }

      setTurnActiveBySession((activePrev) => ({ ...activePrev, ...activePatch }));
      setApprovalsBySession((approvalPrev) => ({ ...approvalPrev, ...approvalPatch }));

      return next;
    });
  }, []);

  const scheduleQueuedEventFlush = useCallback(() => {
    if (eventFlushTimerRef.current != null) return;
    eventFlushTimerRef.current = window.setTimeout(() => {
      eventFlushTimerRef.current = null;
      flushQueuedEvents();
    }, 16);
  }, [flushQueuedEvents]);

  const scheduleSessionsRefresh = useCallback(() => {
    if (refreshSessionsTimerRef.current != null) return;
    refreshSessionsTimerRef.current = window.setTimeout(() => {
      refreshSessionsTimerRef.current = null;
      void refreshSessions().catch(() => {});
    }, 120);
  }, [refreshSessions]);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      pendingEventQueueRef.current.push(envelope);
      scheduleQueuedEventFlush();

      if (lockSessionId && envelope.sessionId === lockSessionId) {
        draftSelectionLockedRef.current = false;
        setSelectedSessionId(lockSessionId);
      }

      if (envelope.event.type === "done") {
        scheduleSessionsRefresh();
      }
    });
    return unsubscribe;
  }, [lockSessionId, scheduleQueuedEventFlush, scheduleSessionsRefresh]);

  useEffect(() => () => {
    if (eventFlushTimerRef.current != null) {
      window.clearTimeout(eventFlushTimerRef.current);
    }
    if (refreshSessionsTimerRef.current != null) {
      window.clearTimeout(refreshSessionsTimerRef.current);
    }
    pendingEventQueueRef.current = [];
  }, []);

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
    const provider = desc?.isCliWrapped
      ? (desc.family === "openai" ? "codex" : "claude")
      : "unified";
    const model = provider === "unified" ? modelId : (desc?.shortId ?? modelId);
    const created = await window.ade.agentChat.create({
      laneId,
      provider,
      model,
      modelId,
      reasoningEffort,
      permissionMode
    });
    loadedHistoryRef.current.delete(created.id);
    optimisticSessionIdsRef.current.add(created.id);
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(created.id);
    void refreshSessions().catch(() => {});
    return created.id;
  }, [laneId, modelId, permissionMode, reasoningEffort, refreshSessions]);

  const submit = useCallback(async () => {
    const text = draft.trim();
    if (!text.length || !laneId) return;

    setBusy(true);
    setError(null);
    try {
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
      const selectedModelChanged =
        Boolean(selectedSessionId)
        && Boolean(selectedSessionModelId)
        && selectedSessionModelId !== modelId;
      const canRetargetSelectedSession =
        Boolean(sessionId)
        && selectedModelChanged
        && selectedEvents.length === 0
        && !turnActive;
      if (canRetargetSelectedSession && sessionId) {
        await window.ade.agentChat.updateSession({
          sessionId,
          modelId,
          reasoningEffort,
          permissionMode
        });
        await refreshSessions();
      } else if (!sessionId || selectedModelChanged) {
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
  }, [
    attachments,
    createSession,
    draft,
    laneId,
    modelId,
    reasoningEffort,
    refreshSessions,
    permissionMode,
    selectedContextPacks,
    selectedEvents.length,
    selectedSessionId,
    selectedSessionModelId,
    turnActive,
    turnActiveBySession
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      await window.ade.agentChat.interrupt({ sessionId: selectedSessionId });
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError));
    }
  }, [selectedSessionId]);

  const approve = useCallback(async (decision: AgentChatApprovalDecision, responseText?: string | null) => {
    if (!selectedSessionId) return;
    const approval = approvalsBySession[selectedSessionId]?.[0];
    if (!approval) return;
    try {
      await window.ade.agentChat.approve({
        sessionId: selectedSessionId,
        itemId: approval.itemId,
        decision,
        responseText,
      });
      setApprovalsBySession((prev) => ({
        ...prev,
        [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((entry) => entry.itemId !== approval.itemId)
      }));
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    }
  }, [approvalsBySession, selectedSessionId]);

  const handlePermissionModeChange = useCallback(async (mode: AgentChatPermissionMode) => {
    setPermissionMode(mode);
    if (selectedSessionId) {
      try {
        await window.ade.agentChat.changePermissionMode({
          sessionId: selectedSessionId,
          permissionMode: mode
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    }
  }, [selectedSessionId]);

  if (!laneId) {
    return (
      <div className="flex h-full items-center justify-center">
        <span className="font-mono text-[11px] text-muted-fg/30">Select a lane to start chatting</span>
      </div>
    );
  }

  const sessionModelDesc = selectedSession?.modelId ? getModelById(selectedSession.modelId) : null;
  const sessionTitle = selectedSession ? chatSessionTitle(selectedSession) : null;
  const sessionLabel = sessionModelDesc?.displayName
    ?? (selectedSession ? `${selectedSession.provider}/${selectedSession.model}` : null);
  const sessionModelColor = sessionModelDesc?.color ?? selectedModelDesc?.color ?? "#A78BFA";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* ── Session tabs ── */}
      {!lockSessionId ? (
        <div className="flex items-center gap-0 border-b border-border/8 bg-[var(--color-surface)]">
          <div className="flex min-w-0 flex-1 items-center overflow-x-auto">
            {sessions.map((session, index) => {
              const desc = session.modelId ? getModelById(session.modelId) : MODEL_REGISTRY.find((m) => m.shortId === session.model);
              const title = chatSessionTitle(session);
              const secondaryCandidate = preferredChatLabel(session.summary);
              const secondary = secondaryCandidate && secondaryCandidate !== title
                ? secondaryCandidate
                : desc?.displayName ?? `${session.provider}/${session.model}`;
              const isActive = session.sessionId === selectedSessionId;
              const isRunning = turnActiveBySession[session.sessionId] ?? false;
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  className={cn(
                    "group flex shrink-0 flex-col items-start gap-1 border-b-2 px-3 py-2 text-left transition-colors",
                    isActive
                      ? "border-b-accent bg-accent/[0.06] text-fg/95"
                      : "border-b-transparent text-fg/50 hover:bg-border/6 hover:text-fg/75"
                  )}
                  style={{
                    minWidth: 180,
                    backgroundImage: isActive
                      ? `linear-gradient(180deg, ${desc?.color ?? "var(--color-accent)"}14 0%, transparent 100%)`
                      : undefined,
                  }}
                  onClick={() => {
                    draftSelectionLockedRef.current = false;
                    syncComposerToSession(session);
                    setSelectedSessionId(session.sessionId);
                  }}
                >
                  <span className="flex w-full items-center gap-2">
                    <span
                      className="font-mono text-[9px] font-bold uppercase tracking-[0.18em]"
                      style={{ color: isActive ? desc?.color ?? "var(--color-accent)" : "var(--color-muted-fg)" }}
                    >
                      {String(index + 1).padStart(2, "0")}
                    </span>
                    <ToolLogo toolType={chatToolTypeForProvider(session.provider)} size={12} />
                    <span className="truncate font-mono text-[11px] text-fg/90">{title}</span>
                    <span
                      className={cn(
                        "ml-auto h-2 w-2 rounded-full transition-opacity",
                        isRunning ? "animate-pulse opacity-100" : "opacity-70"
                      )}
                      style={{ backgroundColor: desc?.color ?? "#A78BFA" }}
                    />
                  </span>
                  <span className="max-w-[170px] truncate font-mono text-[9px] uppercase tracking-[0.12em] text-muted-fg/60">
                    {secondary.length ? secondary : desc?.displayName ?? `${session.provider}/${session.model}`}
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="flex h-full shrink-0 items-center gap-1 border-l border-border/8 px-3 py-2 font-mono text-[10px] text-muted-fg/30 transition-colors hover:bg-accent/[0.04] hover:text-accent/60"
            title="New chat"
            onClick={() => {
              draftSelectionLockedRef.current = true;
              setError(null);
              setSelectedSessionId(null);
              setDraft("");
              setAttachments([]);
              setSelectedContextPacks([]);
            }}
          >
            <Plus size={12} weight="bold" />
          </button>
        </div>
      ) : null}

      {/* ── Model badge + session info ── */}
      <div className="flex items-center gap-3 border-b border-border/8 px-4 py-1.5">
        <span
          className="inline-flex items-center gap-1.5 border px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider"
          style={{
            borderColor: `${sessionModelColor}30`,
            backgroundColor: `${sessionModelColor}0A`,
            color: sessionModelColor
          }}
        >
          <span className="inline-block h-1.5 w-1.5" style={{ backgroundColor: sessionModelColor }} />
          {sessionTitle ?? sessionLabel ?? selectedModelDesc?.displayName ?? "No model"}
        </span>

        {selectedSession ? sessionLabel && sessionTitle !== sessionLabel ? (
          <span className="font-mono text-[10px] text-muted-fg/30">
            {sessionLabel}
          </span>
        ) : null : null}

        {turnActive ? (
          <span className="inline-flex items-center gap-1 font-mono text-[9px] font-bold uppercase tracking-widest text-accent/60">
            <span className="h-1.5 w-1.5 animate-pulse bg-accent" />
            Active
          </span>
        ) : null}

        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            className="flex items-center gap-1 px-1.5 py-0.5 text-muted-fg/25 transition-colors hover:text-muted-fg/50"
            onClick={() => {
              setError(null);
              refreshSessions().catch((refreshError) => {
                setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
              });
            }}
            title="Refresh sessions"
          >
            <ArrowsClockwise size={11} weight="bold" />
          </button>
        </div>
      </div>

      {/* ── Error bar ── */}
      {error ? (
        <div className="border-b border-red-500/10 bg-gradient-to-r from-red-500/[0.05] to-transparent px-4 py-2 font-mono text-[11px] text-red-400/70">
          {error}
        </div>
      ) : null}

      {/* ── Message area ── */}
      <div className="min-h-0 flex-1">
        {loading ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex flex-col items-center gap-3">
              <div className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-bounce bg-accent/50 rounded-full [animation-delay:0ms]" />
                <span className="h-1.5 w-1.5 animate-bounce bg-accent/50 rounded-full [animation-delay:150ms]" />
                <span className="h-1.5 w-1.5 animate-bounce bg-accent/50 rounded-full [animation-delay:300ms]" />
              </div>
              <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-fg/25">Loading sessions...</span>
            </div>
          </div>
        ) : selectedSessionId ? (
          <AgentChatMessageList
            events={selectedEvents}
            showStreamingIndicator={turnActive}
            className="border-0"
            onApproval={(itemId, decision, responseText) => {
              if (!selectedSessionId) return;
              window.ade.agentChat.approve({ sessionId: selectedSessionId, itemId, decision, responseText }).then(() => {
                setApprovalsBySession((prev) => ({
                  ...prev,
                  [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((e) => e.itemId !== itemId)
                }));
              }).catch((err) => {
                setError(err instanceof Error ? err.message : String(err));
              });
            }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-5 px-8">
            {/* Icon with glow */}
            <div className="relative flex items-center justify-center">
              <div
                className="absolute h-16 w-16 rounded-full blur-2xl"
                style={{ backgroundColor: `${selectedModelDesc?.color ?? "#A78BFA"}18` }}
              />
              <div
                className="relative flex h-12 w-12 items-center justify-center border"
                style={{
                  borderColor: `${selectedModelDesc?.color ?? "#A78BFA"}25`,
                  backgroundColor: `${selectedModelDesc?.color ?? "#A78BFA"}0A`,
                }}
              >
                <ChatCircle size={24} weight="thin" style={{ color: selectedModelDesc?.color ?? "#A78BFA", opacity: 0.5 }} />
              </div>
            </div>
            {/* Model name */}
            <div className="flex flex-col items-center gap-1">
              <span className="font-sans text-[13px] font-medium text-fg/60">
                {selectedModelDesc?.displayName ?? "Ready to chat"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-[2px] text-muted-fg/30">
                Start a conversation
              </span>
            </div>
            {/* Starter prompts */}
            <div className="flex flex-col items-stretch gap-1.5 w-full max-w-[260px]">
              {[
                "Explain the current project structure",
                "Review the recent code changes",
                "Help me plan the next feature",
              ].map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  className="border border-border/15 bg-surface/30 px-3 py-2 text-left font-mono text-[10px] text-muted-fg/45 transition-colors hover:border-accent/20 hover:bg-accent/[0.05] hover:text-fg/60"
                  onClick={() => setDraft(prompt)}
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Composer ── */}
      <AgentChatComposer
        modelId={modelId}
        availableModelIds={effectiveAvailableModelIds}
        reasoningEffort={reasoningEffort}
        draft={draft}
        attachments={attachments}
        pendingApproval={pendingApproval}
        turnActive={turnActive}
        sendOnEnter={sendOnEnter}
        busy={busy}
        selectedContextPacks={selectedContextPacks}
        laneId={laneId ?? undefined}
        permissionMode={permissionMode}
        sessionProvider={sessionProvider}
        sessionIsCliWrapped={sessionIsCliWrapped}
        onPermissionModeChange={handlePermissionModeChange}
        onModelChange={(nextModelId) => {
          if (selectedSessionModelId && effectiveAvailableModelIds.length && !effectiveAvailableModelIds.includes(nextModelId)) {
            return;
          }
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
      {pendingQuestion && selectedSessionId ? (
        <AgentQuestionModal
          question={pendingQuestion}
          onClose={() => {
            void approve("cancel");
          }}
          onSubmit={(answer) => {
            void approve("accept", answer);
          }}
          onDecline={() => {
            void approve("decline");
          }}
        />
      ) : null}
    </div>
  );
}
