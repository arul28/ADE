import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Database, Plus } from "@phosphor-icons/react";
import {
  createDefaultComputerUsePolicy,
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatExecutionMode,
  type AgentChatEvent,
  type AgentChatEventEnvelope,
  type AgentChatFileRef,
  type AgentChatPermissionMode,
  type ChatSurfaceChip,
  type ChatSurfaceProfile,
  type ChatSurfacePresentation,
  type AgentChatSessionSummary,
  type ComputerUseOwnerSnapshot,
  type ComputerUsePolicy,
  type ContextPackOption,
} from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { getDefaultModelDescriptor, MODEL_REGISTRY, getModelById, type ModelDescriptor } from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { cn } from "../ui/cn";
import { AgentChatComposer } from "./AgentChatComposer";
import { AgentChatMessageList } from "./AgentChatMessageList";
import { AgentQuestionModal } from "./AgentQuestionModal";
import { isChatToolType } from "../../lib/sessions";
import { ToolLogo } from "../terminals/ToolLogos";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import { ChatSurfaceShell } from "./ChatSurfaceShell";
import { chatChipToneClass } from "./chatSurfaceTheme";
import { useChatMcpSummary } from "./useChatMcpSummary";
import { openExternalMcpSettings } from "./chatNavigation";
import { normalizePermissionModeForProfile } from "../shared/permissionOptions";

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

const DEFAULT_MODEL_ID = getDefaultModelDescriptor("unified")?.id
  ?? getDefaultModelDescriptor("claude")?.id
  ?? MODEL_REGISTRY.find((model) => model.family === "anthropic" && model.isCliWrapped)?.id
  ?? MODEL_REGISTRY[0]?.id
  ?? "openai/gpt-5.4";
const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;

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

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractAskUserQuestion(approval: PendingApproval | null): { question: string; options?: Array<{ label: string; value: string }> } | null {
  if (!approval || approval.kind !== "tool_call") return null;
  const detail = readRecord(approval.detail);
  const tool = typeof detail?.tool === "string" ? detail.tool.trim() : "";
  const question = typeof detail?.question === "string" ? detail.question.trim() : "";
  if (tool !== "askUser" || !question.length) return null;
  let options: Array<{ label: string; value: string }> | undefined;
  if (Array.isArray(detail?.options)) {
    const parsed = (detail.options as unknown[]).filter(
      (opt): opt is { label: string; value: string } =>
        opt !== null && typeof opt === "object" && typeof (opt as Record<string, unknown>).label === "string" && typeof (opt as Record<string, unknown>).value === "string",
    );
    if (parsed.length > 0) options = parsed;
  }
  return { question, options };
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
  return stripOutcomePrefix(normalized);
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
  const preferDraftStart = !lockSessionId && !initialSessionId && !forceNewSession;
  const surfaceProfile: ChatSurfaceProfile = presentation?.profile ?? "standard";
  const isPersistentIdentitySurface = surfaceProfile === "persistent_identity";
  const modelSwitchPolicy = presentation?.modelSwitchPolicy ?? "same-family-after-launch";
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(lockSessionId ?? initialSessionId ?? null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [turnActiveBySession, setTurnActiveBySession] = useState<Record<string, boolean>>({});
  const [approvalsBySession, setApprovalsBySession] = useState<Record<string, PendingApproval[]>>({});
  const [modelId, setModelId] = useState<string>("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<AgentChatExecutionMode>("focused");
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [permissionMode, setPermissionMode] = useState<AgentChatPermissionMode>(
    surfaceProfile === "persistent_identity" ? "full-auto" : "plan",
  );
  const [computerUsePolicy, setComputerUsePolicy] = useState<ComputerUsePolicy>(createDefaultComputerUsePolicy());
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [selectedContextPacks, setSelectedContextPacks] = useState<ContextPackOption[]>([]);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<import("../../../shared/types").AgentChatSlashCommand[]>([]);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [computerUseSnapshot, setComputerUseSnapshot] = useState<ComputerUseOwnerSnapshot | null>(null);
  const [sessionMutationKind, setSessionMutationKind] = useState<"model" | "permission" | "computer-use" | null>(null);

  const appliedInitialSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());
  const draftSelectionLockedRef = useRef(false);
  const optimisticSessionIdsRef = useRef<Set<string>>(new Set());
  const submitInFlightRef = useRef(false);
  const createSessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const pendingEventQueueRef = useRef<AgentChatEventEnvelope[]>([]);
  const eventsBySessionRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const eventFlushTimerRef = useRef<number | null>(null);
  const refreshSessionsTimerRef = useRef<number | null>(null);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const computerUseSnapshotInFlightRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const lastComputerUseSnapshotRef = useRef<{ sessionId: string; fetchedAt: number } | null>(null);
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  const showMcpStatus = presentation?.showMcpStatus ?? true;
  const mcpSummary = useChatMcpSummary(showMcpStatus);

  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.sessionId === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId]
  );
  const laneDisplayLabel = useMemo(() => {
    const normalized = laneLabel?.trim();
    return normalized?.length ? normalized : laneId;
  }, [laneId, laneLabel]);
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
  const surfaceMode = presentation?.mode ?? "standard";
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

  const sessionIsCliWrapped = useMemo(() => {
    if (selectedSessionModelId && !modelSelectionDiffersFromSession) {
      const desc = getModelById(selectedSessionModelId);
      return desc?.isCliWrapped ?? false;
    }
    return selectedModelDesc?.isCliWrapped ?? false;
  }, [selectedSessionModelId, modelSelectionDiffersFromSession, selectedModelDesc]);
  const permissionFamily = useMemo(
    () => selectedModelDesc?.family
      ?? (sessionProvider === "claude" ? "anthropic" : sessionProvider === "codex" ? "openai" : "unified"),
    [selectedModelDesc?.family, sessionProvider],
  );
  const permissionIsCliWrapped = useMemo(
    () => selectedModelDesc?.isCliWrapped ?? sessionIsCliWrapped ?? false,
    [selectedModelDesc?.isCliWrapped, sessionIsCliWrapped],
  );
  const coercePermissionMode = useCallback(
    (mode?: AgentChatPermissionMode | null): AgentChatPermissionMode =>
      normalizePermissionModeForProfile({
        profile: surfaceProfile,
        family: permissionFamily,
        isCliWrapped: permissionIsCliWrapped,
        mode: mode ?? (surfaceProfile === "persistent_identity" ? "full-auto" : "plan"),
      }),
    [permissionFamily, permissionIsCliWrapped, surfaceProfile],
  );

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) return;
    const nextModelId = session.modelId ?? resolveRegistryModelId(session.model);
    if (nextModelId) {
      setModelId(nextModelId);
    }
    setReasoningEffort(session.reasoningEffort ?? null);
    setExecutionMode(session.executionMode ?? "focused");
    setPermissionMode(coercePermissionMode(session.permissionMode));
    setComputerUsePolicy(session.computerUse ?? createDefaultComputerUsePolicy());
  }, [coercePermissionMode]);
  const executionModeOptions = useMemo(
    () => getExecutionModeOptions(selectedModelDesc),
    [selectedModelDesc],
  );
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
  const resolvedSubtitle = presentation?.subtitle?.trim()
    || (surfaceMode === "resolver"
      ? "Model and permission stay locked after launch, but the transcript and follow-ups stay in one smooth surface."
      : "Same chat core, tuned for the current workflow.");
  const chipsJson = JSON.stringify(presentation?.chips ?? []);
  const resolvedChips = useMemo(() => JSON.parse(chipsJson) as ChatSurfaceChip[], [chipsJson]);
  const mcpChip: ChatSurfaceChip | null = showMcpStatus && mcpSummary
    ? {
        label: mcpSummary.connectedCount > 0
          ? `MCP ${mcpSummary.connectedCount}/${mcpSummary.configuredCount}`
          : mcpSummary.configuredCount > 0
            ? `MCP ${mcpSummary.configuredCount} configured`
            : "MCP not configured",
        tone: mcpSummary.connectedCount > 0
          ? "success"
          : mcpSummary.configuredCount > 0
            ? "info"
            : "muted",
      }
    : null;

  // Keep all configured models selectable, and always include the active session model.
  // Most launched chats stay in the same family; special surfaces such as CTO
  // can opt into cross-family switching after the conversation has started.
  const effectiveAvailableModelIds = useMemo(() => {
    return filterChatModelIdsForSession({
      availableModelIds: availableModelIdsOverride?.length ? availableModelIdsOverride : availableModelIds,
      activeSessionModelId: selectedSessionModelId,
      hasConversation: selectedEvents.length > 0,
      policy: modelSwitchPolicy,
    });
  }, [availableModelIds, availableModelIdsOverride, modelSwitchPolicy, selectedSessionModelId, selectedEvents.length]);

  const refreshAvailableModels = useCallback(async () => {
    try {
      const status = await window.ade.ai.getStatus();
      const available = deriveConfiguredModelIds(status);
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
      if (!current && (draftSelectionLockedRef.current || forceDraft || preferDraftStart)) return null;
      if (current && rows.some((row) => row.sessionId === current)) return current;
      if (current && optimisticSessionIdsRef.current.has(current)) return current;
      return rows[0]?.sessionId ?? null;
    });
  }, [forceDraft, laneId, lockSessionId, preferDraftStart]);

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
      if (inFlight?.sessionId === sessionId) {
        return inFlight.promise;
      }
      const previous = lastComputerUseSnapshotRef.current;
      if (previous?.sessionId === sessionId && Date.now() - previous.fetchedAt < COMPUTER_USE_SNAPSHOT_COOLDOWN_MS) {
        return;
      }
    }

    let request: Promise<void> | null = null;
    request = (async () => {
      try {
        const snapshot = await window.ade.computerUse.getOwnerSnapshot({
          owner: { kind: "chat_session", id: sessionId },
        });
        lastComputerUseSnapshotRef.current = {
          sessionId,
          fetchedAt: Date.now(),
        };
        if (selectedSessionIdRef.current === sessionId) {
          setComputerUseSnapshot(snapshot);
        }
      } catch {
        if (selectedSessionIdRef.current === sessionId) {
          setComputerUseSnapshot(null);
        }
      } finally {
        if (request && computerUseSnapshotInFlightRef.current?.promise === request) {
          computerUseSnapshotInFlightRef.current = null;
        }
      }
    })();
    computerUseSnapshotInFlightRef.current = { sessionId, promise: request };
    try {
      await request;
    } catch {
      // Errors are reflected by clearing the visible snapshot for the active session.
    }
  }, []);

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
      const parsed = parseAgentChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);

      // If real-time events have already been received for this session
      // (via flushQueuedEvents), the on-disk transcript may be stale.
      // Merge: use the loaded history as a base but keep any real-time
      // events that arrived after the last event in the transcript.
      const existing = eventsBySessionRef.current[sessionId] ?? [];
      let merged: AgentChatEventEnvelope[];
      if (existing.length && parsed.length) {
        // Find real-time events that are newer than the last transcript entry.
        const lastParsedTs = parsed[parsed.length - 1]!.timestamp;
        const tail = existing.filter((e) => e.timestamp > lastParsedTs);
        merged = tail.length ? [...parsed, ...tail] : parsed;
      } else if (existing.length) {
        // No transcript on disk — keep the real-time events as-is.
        merged = existing;
      } else {
        merged = parsed;
      }

      const derived = deriveRuntimeState(merged);
      eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: merged };
      setEventsBySession((prev) => ({ ...prev, [sessionId]: merged }));
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
    if (!lockedSingleSessionMode || !lockSessionId || !initialSessionSummary) return;
    setSessions([initialSessionSummary]);
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(lockSessionId);
  }, [initialSessionSummary, lockSessionId, lockedSingleSessionMode]);

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
    if (forceDraft && !lockSessionId) {
      draftSelectionLockedRef.current = true;
      setSelectedSessionId(null);
    }
  }, [forceDraft, laneId, lockSessionId]);

  useEffect(() => {
    if (!forceDraft || lockSessionId) return;
    draftSelectionLockedRef.current = true;
    setSelectedSessionId(null);
  }, [forceDraft, lockSessionId]);

  useEffect(() => {
    syncComposerToSession(selectedSession);
  }, [selectedSession?.sessionId, selectedSessionModelId, syncComposerToSession]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      setLoading(true);
      setPreferencesReady(false);
      try {
        const snapshot = await window.ade.projectConfig.get();
        const chat = snapshot.effective.ai?.chat;
        if (!cancelled) {
          // Don't auto-restore model — user must pick one explicitly each session
          setSendOnEnter(chat?.sendOnEnter ?? true);
        }
      } catch {
        // fall back to defaults.
      }

      try {
        if (lockedSingleSessionMode) {
          if (!cancelled && initialSessionSummary) {
            setSessions([initialSessionSummary]);
            setSelectedSessionId(lockSessionId ?? initialSessionSummary.sessionId);
          }
          await refreshAvailableModels();
        } else {
          await Promise.all([refreshAvailableModels(), refreshSessions()]);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          setPreferencesReady(true);
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [initialSessionSummary, lockSessionId, lockedSingleSessionMode, refreshAvailableModels, refreshSessions]);

  useEffect(() => {
    if (loading || !availableModelIds.length) return;
    // If the user hasn't picked a model yet, don't auto-select one.
    if (!modelId) return;
    if (availableModelIds.includes(modelId)) return;
    if (selectedSessionModelId) {
      setModelId(selectedSessionModelId);
      return;
    }
    const preferred = readLastUsedModelId();
    if (preferred && availableModelIds.includes(preferred)) {
      setModelId(preferred);
    } else {
      setModelId(availableModelIds[0]!);
    }
  }, [loading, availableModelIds, modelId, selectedSessionModelId]);

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
    if (!executionModeOptions.length) {
      if (executionMode !== "focused") setExecutionMode("focused");
      return;
    }
    if (executionModeOptions.some((option) => option.value === executionMode)) return;
    setExecutionMode(executionModeOptions[0]!.value);
  }, [executionMode, executionModeOptions]);

  useEffect(() => {
    const nextMode = selectedSession
      ? coercePermissionMode(selectedSession.permissionMode)
      : coercePermissionMode(undefined);
    setPermissionMode((current) => (current === nextMode ? current : nextMode));
  }, [coercePermissionMode, selectedSession]);

  useEffect(() => {
    selectedSessionIdRef.current = selectedSessionId;
  }, [selectedSessionId]);

  useEffect(() => {
    const next = new Set<string>();
    for (const session of sessions) next.add(session.sessionId);
    if (selectedSessionId) next.add(selectedSessionId);
    if (lockSessionId) next.add(lockSessionId);
    if (initialSessionId) next.add(initialSessionId);
    for (const sessionId of optimisticSessionIdsRef.current) next.add(sessionId);
    knownSessionIdsRef.current = next;
  }, [initialSessionId, lockSessionId, selectedSessionId, sessions]);

  useEffect(() => {
    if (!selectedSessionId) return;
    if (!lockedSingleSessionMode) {
      void loadHistory(selectedSessionId);
      return;
    }
    const handle = window.setTimeout(() => {
      void loadHistory(selectedSessionId);
    }, 120);
    return () => window.clearTimeout(handle);
  }, [loadHistory, lockedSingleSessionMode, selectedSessionId]);

  useEffect(() => {
    if (!lockedSingleSessionMode) {
      void refreshComputerUseSnapshot(selectedSessionId);
      return;
    }
    const handle = window.setTimeout(() => {
      void refreshComputerUseSnapshot(selectedSessionId);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [lockedSingleSessionMode, refreshComputerUseSnapshot, selectedSessionId]);

  useEffect(() => {
    setAttachments([]);
  }, [selectedSessionId]);

  // Fetch SDK slash commands when session changes
  useEffect(() => {
    if (!selectedSessionId) { setSdkSlashCommands([]); return; }
    let cancelled = false;
    window.ade.agentChat.slashCommands({ sessionId: selectedSessionId })
      .then((cmds) => { if (!cancelled) setSdkSlashCommands(cmds); })
      .catch(() => { if (!cancelled) setSdkSlashCommands([]); });
    return () => { cancelled = true; };
  }, [selectedSessionId]);

  const flushQueuedEvents = useCallback(() => {
    const queued = pendingEventQueueRef.current;
    if (!queued.length) return;
    pendingEventQueueRef.current = [];

    // Build the next events map from the ref (latest committed state) so
    // that derived state (turnActive, approvals) can be computed and applied
    // as sibling setState calls in the same synchronous scope.  React 18
    // batches all three updates into a single render, ensuring turnActive
    // never lags behind the events — which previously left the spinner stuck
    // after a "done" event.
    let next = eventsBySessionRef.current;
    const touchedSessionIds = new Set<string>();

    for (const envelope of queued) {
      const sessionId = envelope.sessionId;
      const sessionEvents = next === eventsBySessionRef.current
        ? (eventsBySessionRef.current[sessionId] ?? [])
        : (next[sessionId] ?? []);
      const updated = [...sessionEvents, envelope];
      if (next === eventsBySessionRef.current) {
        next = { ...eventsBySessionRef.current };
      }
      next[sessionId] = updated;
      touchedSessionIds.add(sessionId);
    }

    if (!touchedSessionIds.size) return;

    // Commit the ref immediately so subsequent flushes see the latest events.
    eventsBySessionRef.current = next;

    // Derive turnActive and approvals from the fully-updated event lists.
    const activePatch: Record<string, boolean> = {};
    const approvalPatch: Record<string, PendingApproval[]> = {};
    for (const sessionId of touchedSessionIds) {
      const derived = deriveRuntimeState(next[sessionId] ?? []);
      activePatch[sessionId] = derived.turnActive;
      approvalPatch[sessionId] = derived.pendingApprovals;
    }

    // All three setters fire synchronously — React 18 batches them into one render.
    setEventsBySession(next);
    setTurnActiveBySession((activePrev) => ({ ...activePrev, ...activePatch }));
    setApprovalsBySession((approvalPrev) => ({ ...approvalPrev, ...approvalPatch }));
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
      if (!knownSessionIdsRef.current.has(envelope.sessionId)) return;
      pendingEventQueueRef.current.push(envelope);

      // "done" events must flush immediately so turnActive clears and the
      // spinner stops.  Other events can use the debounced 16ms schedule.
      if (envelope.event.type === "done") {
        if (eventFlushTimerRef.current != null) {
          window.clearTimeout(eventFlushTimerRef.current);
          eventFlushTimerRef.current = null;
        }
        flushQueuedEvents();
      } else {
        scheduleQueuedEventFlush();
      }

      if (lockSessionId && envelope.sessionId === lockSessionId) {
        draftSelectionLockedRef.current = false;
        setSelectedSessionId(lockSessionId);
      }

      if (envelope.event.type === "done") {
        scheduleSessionsRefresh();
        // Refresh slash commands — SDK may have reported them during this turn's init
        if (envelope.sessionId === selectedSessionIdRef.current) {
          window.ade.agentChat.slashCommands({ sessionId: envelope.sessionId })
            .then(setSdkSlashCommands)
            .catch(() => {});
        }
      }
    });
    return unsubscribe;
  }, [lockSessionId, flushQueuedEvents, scheduleQueuedEventFlush, scheduleSessionsRefresh]);

  useEffect(() => {
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      if (!selectedSessionId) return;
      if (event.owner?.kind === "chat_session" && event.owner.id === selectedSessionId) {
        void refreshComputerUseSnapshot(selectedSessionId, { force: true });
      }
    });
    return unsubscribe;
  }, [refreshComputerUseSnapshot, selectedSessionId]);

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
    if (!preferencesReady) return;
    if (!modelId.trim().length) return;
    writeLastUsedModelId(modelId);
  }, [modelId, preferencesReady]);

  useEffect(() => {
    if (!preferencesReady) return;
    writeLastUsedReasoningEffort({
      laneId,
      modelId,
      effort: reasoningEffort
    });
  }, [laneId, modelId, preferencesReady, reasoningEffort]);

  const searchAttachments = useCallback(async (query: string): Promise<AgentChatFileRef[]> => {
    if (!laneId) return [];
    const trimmed = query.trim();
    if (!trimmed.length) return [];

    // Try Codex fuzzy file search if we have an active Codex session
    if (selectedSessionId && sessionProvider === "codex") {
      try {
        const codexHits = await window.ade.agentChat.fileSearch({ sessionId: selectedSessionId, query: trimmed });
        if (codexHits.length > 0) {
          return codexHits.map((hit) => ({
            path: hit.path,
            type: inferAttachmentType(hit.path),
          }));
        }
      } catch {
        // Fall through to default search
      }
    }

    const hits = await window.ade.files.quickOpen({
      workspaceId: laneId,
      query: trimmed,
      limit: 60
    });
    return hits.map((hit) => ({
      path: hit.path,
      type: inferAttachmentType(hit.path)
    }));
  }, [laneId, selectedSessionId, sessionProvider]);

  const addAttachment = useCallback((attachment: AgentChatFileRef) => {
    setAttachments((prev) => {
      if (prev.some((entry) => entry.path === attachment.path)) return prev;
      return [...prev, attachment];
    });
  }, []);

  const removeAttachment = useCallback((attachmentPath: string) => {
    setAttachments((prev) => prev.filter((entry) => entry.path !== attachmentPath));
  }, []);

  const patchSessionSummary = useCallback((sessionId: string, patch: Partial<AgentChatSessionSummary>) => {
    setSessions((prev) => prev.map((session) => (
      session.sessionId === sessionId ? { ...session, ...patch } : session
    )));
  }, []);

  const createSession = useCallback(async (): Promise<string | null> => {
    if (createSessionPromiseRef.current) {
      return createSessionPromiseRef.current;
    }
    if (!laneId) return null;
    const createPromise = (async () => {
      const desc = getModelById(modelId);
      const provider = desc?.isCliWrapped
        ? (desc.family === "openai" ? "codex" : "claude")
        : "unified";
      const model = provider === "unified" ? modelId : (desc?.shortId ?? modelId);
      const sessionProfile = !lockSessionId && !selectedSessionId ? "light" : "workflow";
      const created = await window.ade.agentChat.create({
        laneId,
        provider,
        model,
        modelId,
        sessionProfile,
        reasoningEffort,
        permissionMode,
        computerUse: computerUsePolicy,
      });
      loadedHistoryRef.current.delete(created.id);
      optimisticSessionIdsRef.current.add(created.id);
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(created.id);
      await onSessionCreated?.(created.id);
      void refreshSessions().catch(() => {});
      return created.id;
    })();
    createSessionPromiseRef.current = createPromise;
    try {
      return await createPromise;
    } finally {
      if (createSessionPromiseRef.current === createPromise) {
        createSessionPromiseRef.current = null;
      }
    }
  }, [computerUsePolicy, laneId, lockSessionId, modelId, onSessionCreated, permissionMode, reasoningEffort, refreshSessions, selectedSessionId]);

  // ── Eager session creation ──
  // Create a lightweight session as soon as we have a model + lane, so slash
  // commands, MCP status, and other pre-chat metadata are available immediately.
  // Skip when the pane is locked to an existing session or in forced-draft mode.
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
  // When the user changes the model before sending any messages, update the
  // existing (empty) session in place. If the provider changed (e.g. Claude →
  // Codex), dispose the stale session and create a fresh one for the new model.
  // The `userChangedModelRef` flag ensures this only fires on explicit user
  // model-picker interactions, NOT during boot when the saved model is loaded.
  const userChangedModelRef = useRef(false);
  useEffect(() => {
    if (!userChangedModelRef.current) return;
    userChangedModelRef.current = false;
    if (isPersistentIdentitySurface) return;
    if (!selectedSessionId || selectedEvents.length > 0 || turnActive) return;
    void (async () => {
      try {
        await window.ade.agentChat.updateSession({ sessionId: selectedSessionId, modelId });
        await refreshSessions();
        window.ade.agentChat.slashCommands({ sessionId: selectedSessionId })
          .then(setSdkSlashCommands)
          .catch(() => {});
      } catch {
        // Provider-incompatible switch — dispose old empty session and create fresh
        try {
          await window.ade.agentChat.dispose({ sessionId: selectedSessionId });
        } catch { /* ignore */ }
        setSelectedSessionId(null);
        eagerCreateFiredRef.current = false; // allow eager effect to re-fire
      }
    })();
  }, [isPersistentIdentitySurface, modelId, selectedSessionId, selectedEvents.length, turnActive, refreshSessions]);

  const submit = useCallback(async () => {
    if (submitInFlightRef.current || busy) return;
    if (!modelId) return;
    const text = draft.trim();
    if (!text.length || !laneId) return;
    const draftSnapshot = draft;
    const attachmentsSnapshot = attachments;
    const contextPackSnapshot = selectedContextPacks;

    submitInFlightRef.current = true;
    setBusy(true);
    setError(null);
    setDraft("");
    setAttachments([]);
    setSelectedContextPacks([]);
    try {
      let finalText = text;
      if (contextPackSnapshot.length) {
        const packContents: string[] = [];
        for (const pack of contextPackSnapshot) {
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

      if (sessionId && !turnActive && (selectedModelChanged || hasComputerUseSelectionChanged)) {
        await window.ade.agentChat.updateSession({
          sessionId,
          modelId,
          reasoningEffort,
          permissionMode,
          computerUse: computerUsePolicy,
        });
        await refreshSessions();
      } else if (!sessionId) {
        // No session yet — create one
        sessionId = await createSession();
      }
      if (!sessionId) {
        throw new Error("Unable to create chat session.");
      }

      const selectedAttachments = attachmentsSnapshot;
      if (turnActiveBySession[sessionId]) {
        const steerText = selectedAttachments.length
          ? `${finalText}\n\nAttached context:\n${selectedAttachments.map((entry) => `- ${entry.type}: ${entry.path}`).join("\n")}`
          : finalText;
        await window.ade.agentChat.steer({ sessionId, text: steerText });
      } else {
        await window.ade.agentChat.send({
          sessionId,
          text: finalText,
          displayText: text,
          attachments: selectedAttachments,
          reasoningEffort,
          executionMode: launchModeEditable ? executionMode : null,
        });
      }
      await refreshSessions();
    } catch (submitError) {
      setDraft((current) => (current.trim().length ? current : draftSnapshot));
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setSelectedContextPacks((current) => (current.length ? current : contextPackSnapshot));
      setError(submitError instanceof Error ? submitError.message : String(submitError));
    } finally {
      submitInFlightRef.current = false;
      setBusy(false);
    }
  }, [
    attachments,
    busy,
    createSession,
    computerUsePolicy,
    draft,
    executionMode,
    hasComputerUseSelectionChanged,
    laneId,
    launchModeEditable,
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
    const nextMode = coercePermissionMode(mode);
    if (nextMode === permissionMode) return;
    if (isPersistentIdentitySurface && sessionMutationKind) return;
    setPermissionMode(nextMode);
    if (selectedSessionId) {
      patchSessionSummary(selectedSessionId, { permissionMode: nextMode });
      if (isPersistentIdentitySurface) {
        setSessionMutationKind("permission");
      }
      try {
        await window.ade.agentChat.changePermissionMode({
          sessionId: selectedSessionId,
          permissionMode: nextMode
        });
        void refreshSessions().catch(() => {});
      } catch (err) {
        void refreshSessions().catch(() => {});
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (isPersistentIdentitySurface) {
          setSessionMutationKind(null);
        }
      }
    }
  }, [coercePermissionMode, isPersistentIdentitySurface, patchSessionSummary, permissionMode, refreshSessions, selectedSessionId, sessionMutationKind]);

  const handleComputerUsePolicyChange = useCallback(async (nextPolicy: ComputerUsePolicy) => {
    if (isPersistentIdentitySurface && sessionMutationKind) return;
    setComputerUsePolicy(nextPolicy);
    if (!selectedSessionId) return;
    patchSessionSummary(selectedSessionId, { computerUse: nextPolicy });
    if (isPersistentIdentitySurface) {
      setSessionMutationKind("computer-use");
    }
    try {
      await window.ade.agentChat.updateSession({
        sessionId: selectedSessionId,
        computerUse: nextPolicy,
      });
      await refreshSessions();
      await refreshComputerUseSnapshot(selectedSessionId, { force: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (isPersistentIdentitySurface) {
        setSessionMutationKind(null);
      }
    }
  }, [isPersistentIdentitySurface, patchSessionSummary, refreshComputerUseSnapshot, refreshSessions, selectedSessionId, sessionMutationKind]);

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
          <div className="font-sans text-[12px] font-medium text-[var(--chat-accent)]" style={{ opacity: 0.7 }}>
            {resolvedTitle}
          </div>
          {resolvedSubtitle ? (
            <div className="mt-0.5 max-w-3xl font-sans text-[12px] leading-[1.55] text-fg/45">
              {resolvedSubtitle}
            </div>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {isPersistentIdentitySurface && selectedSessionId ? (
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] font-medium text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg"
              onClick={() => {
                eventsBySessionRef.current = { ...eventsBySessionRef.current, [selectedSessionId]: [] };
                setEventsBySession((prev) => ({ ...prev, [selectedSessionId]: [] }));
              }}
            >
              Clear view
            </button>
          ) : null}
          {resolvedChips.map((chip) => (
            <span
              key={`${chip.label}:${chip.tone ?? "accent"}`}
              className={cn(
                "inline-flex items-center rounded-md border px-2 py-1 font-sans text-[10px] font-medium",
                chatChipToneClass(chip.tone),
              )}
            >
              {chip.label}
            </span>
          ))}
          {mcpChip ? (
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded-md border px-2 py-1 font-sans text-[10px] font-medium transition-colors hover:opacity-90",
                chatChipToneClass(mcpChip.tone),
              )}
              onClick={openExternalMcpSettings}
              title="Open External MCP settings"
            >
              <Database size={11} weight="regular" />
              {mcpChip.label}
            </button>
          ) : null}
          {!isPersistentIdentitySurface ? (
            <span
              className="inline-flex items-center rounded-md border px-2 py-1 font-sans text-[10px] font-medium"
              style={{ borderColor: "rgba(125, 211, 252, 0.18)", color: "rgba(186, 230, 253, 0.75)", background: "rgba(14, 165, 233, 0.06)" }}
            >
              CU {computerUsePolicy.mode}
            </span>
          ) : null}
        </div>
      </div>

      {!lockSessionId && !hideSessionTabs ? (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
            {sessions.map((session) => {
              const desc = session.modelId ? getModelById(session.modelId) : MODEL_REGISTRY.find((m) => m.shortId === session.model);
              const title = chatSessionTitle(session);
              const isActive = session.sessionId === selectedSessionId;
              const isRunning = turnActiveBySession[session.sessionId] ?? false;
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  className={cn(
                    "inline-flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 font-sans text-[11px] transition-colors",
                    isActive
                      ? "border-white/[0.08] bg-white/[0.05] font-medium text-fg/80"
                      : "border-transparent text-muted-fg/40 hover:text-fg/60",
                  )}
                  onClick={() => {
                    draftSelectionLockedRef.current = false;
                    syncComposerToSession(session);
                    setSelectedSessionId(session.sessionId);
                  }}
                >
                  <ToolLogo toolType={chatToolTypeForProvider(session.provider)} size={10} />
                  <span className="max-w-[120px] truncate">{title}</span>
                  {isRunning ? (
                    <span className="h-1.5 w-1.5 animate-pulse rounded-full" style={{ backgroundColor: desc?.color ?? "#A78BFA" }} />
                  ) : null}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-white/[0.06] text-muted-fg/30 transition-colors hover:text-fg/60"
            title="New chat"
            onClick={() => {
              draftSelectionLockedRef.current = true;
              setError(null);
              setSelectedSessionId(null);
              setDraft("");
              setAttachments([]);
              setSelectedContextPacks([]);
              setComputerUsePolicy(createDefaultComputerUsePolicy());
            }}
          >
            <Plus size={10} weight="bold" />
          </button>
        </div>
      ) : null}
    </div>
  );

  return (
    <>
      <ChatSurfaceShell
        mode={surfaceMode}
        accentColor={presentation?.accentColor ?? draftAccent}
        header={shellHeader}
        footer={
          <AgentChatComposer
            surfaceMode={surfaceMode}
            surfaceProfile={surfaceProfile}
            sdkSlashCommands={sdkSlashCommands}
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
            executionMode={selectedExecutionMode?.value ?? "focused"}
            computerUsePolicy={computerUsePolicy}
            executionModeOptions={launchModeEditable ? executionModeOptions : []}
            modelSelectionLocked={modelSelectionLocked || sessionMutationKind === "model"}
            permissionModeLocked={permissionModeLocked || identitySessionSettingsBusy}
            onExecutionModeChange={setExecutionMode}
            onPermissionModeChange={handlePermissionModeChange}
            onComputerUsePolicyChange={handleComputerUsePolicyChange}
            onModelChange={(nextModelId) => {
              if (selectedSessionModelId && effectiveAvailableModelIds.length && !effectiveAvailableModelIds.includes(nextModelId)) {
                return;
              }
              if (isPersistentIdentitySurface && sessionMutationKind) {
                return;
              }
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
                const nextProvider = nextDesc?.isCliWrapped
                  ? (nextDesc.family === "openai" ? "codex" : "claude")
                  : "unified";
                const nextModel = nextProvider === "unified" ? nextModelId : (nextDesc?.shortId ?? nextModelId);
                setSessionMutationKind("model");
                patchSessionSummary(selectedSessionId, {
                  provider: nextProvider,
                  model: nextModel,
                  modelId: nextModelId,
                  reasoningEffort: nextReasoningEffort,
                });
                void window.ade.agentChat.updateSession({
                  sessionId: selectedSessionId,
                  modelId: nextModelId,
                  reasoningEffort: nextReasoningEffort,
                  permissionMode,
                  computerUse: computerUsePolicy,
                }).then(() => {
                  window.ade.agentChat.slashCommands({ sessionId: selectedSessionId })
                    .then(setSdkSlashCommands)
                    .catch(() => {});
                  void refreshSessions().catch(() => {});
                }).catch((err) => {
                  setModelId(previousModelId);
                  setReasoningEffort(previousReasoningEffort);
                  void refreshSessions().catch(() => {});
                  setError(err instanceof Error ? err.message : String(err));
                }).finally(() => {
                  setSessionMutationKind(null);
                });
              }

              // Trigger early warmup when the user selects a Claude/Anthropic
              // model so the ~30s subprocess cold-start happens while they type.
              if (selectedSessionId && nextDesc?.family === "anthropic" && nextDesc?.isCliWrapped) {
                window.ade.agentChat.warmupModel({
                  sessionId: selectedSessionId,
                  modelId: nextModelId,
                }).catch(() => { /* warmup is best-effort */ });
              }
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
                eventsBySessionRef.current = { ...eventsBySessionRef.current, [selectedSessionId]: [] };
                setEventsBySession((prev) => ({ ...prev, [selectedSessionId]: [] }));
              }
            }}
          />
        }
        bodyClassName="flex min-h-0 flex-col overflow-hidden"
      >
        {error ? (
          <div className="border-b border-red-500/10 px-4 py-2 font-mono text-[10px] text-red-300/80">
            {error}
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
              {/* Computer Use panel hidden -- policy is still configurable from the composer */}
              <AgentChatMessageList
                events={selectedEvents}
                showStreamingIndicator={turnActive}
                className="min-h-0 border-0"
                surfaceMode={surfaceMode}
                surfaceProfile={surfaceProfile}
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
            </div>
          ) : (
            <div className="flex h-full flex-col items-center justify-center px-6">
              <div className="flex flex-col items-center gap-4 text-center">
                <div className="flex items-center gap-2">
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: draftAccent }} />
                  <span className="font-mono text-[10px] font-bold uppercase tracking-[2px] text-muted-fg/40">
                    {laneDisplayLabel}
                  </span>
                </div>
                <div className="font-sans text-[15px] font-medium tracking-tight text-fg/60">
                  Start typing below
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2">
                  {[
                    "Explain the project structure",
                    "Review recent changes",
                    "Plan the next feature",
                    "Find bugs and propose fixes",
                  ].map((prompt) => (
                    <button
                      key={prompt}
                      type="button"
                      className="rounded-[var(--chat-radius-pill)] border border-white/8 bg-black/10 px-3 py-2 text-left font-mono text-[10px] text-muted-fg/42 transition-colors hover:border-white/16 hover:text-fg/72"
                      onClick={() => setDraft(prompt)}
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </ChatSurfaceShell>
      {pendingQuestion && selectedSessionId ? (
        <AgentQuestionModal
          question={pendingQuestion.question}
          options={pendingQuestion.options}
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
    </>
  );
}
