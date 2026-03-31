import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { GitBranch, Plus } from "@phosphor-icons/react";
import {
  createDefaultComputerUsePolicy,
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatExecutionMode,
  type AgentChatEventEnvelope,
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AiProviderConnectionStatus,
  type AgentChatUnifiedPermissionMode,
  type AgentChatSessionProfile,
  type ChatSurfaceChip,
  type ChatSurfaceProfile,
  type ChatSurfacePresentation,
  type AgentChatSessionSummary,
  type ComputerUseOwnerSnapshot,
  type ComputerUsePolicy,
} from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { MODEL_REGISTRY, getModelById, type ModelDescriptor } from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { cn } from "../ui/cn";
import { AgentChatComposer } from "./AgentChatComposer";
import { AgentChatMessageList } from "./AgentChatMessageList";
import { AgentQuestionModal } from "./AgentQuestionModal";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { isChatToolType } from "../../lib/sessions";
import { ToolLogo } from "../terminals/ToolLogos";
import { deriveConfiguredModelIds } from "../../lib/modelOptions";
import {
  compareChatSessionsByEffectiveRecency,
  getChatSessionLocalTouchTimestampForEvent,
  shouldRefreshSessionListForChatEvent,
} from "../../lib/chatSessionEvents";
import { ChatSurfaceShell } from "./ChatSurfaceShell";
import { chatChipToneClass } from "./chatSurfaceTheme";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";
import { deriveChatSubagentSnapshots } from "./chatExecutionSummary";
import { derivePendingInputRequests, type DerivedPendingInput } from "./pendingInput";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useAppStore } from "../../state/appStore";

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";

const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;

export function resolveChatSessionProfile(_computerUsePolicy: ComputerUsePolicy): AgentChatSessionProfile {
  return "workflow";
}

export function shouldPromoteSessionForComputerUse(
  session: Pick<AgentChatSessionSummary, "sessionProfile"> | null | undefined,
  _computerUsePolicy: ComputerUsePolicy,
): boolean {
  return session?.sessionProfile !== "workflow";
}

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

function deriveRuntimeState(events: AgentChatEventEnvelope[]): {
  turnActive: boolean;
  pendingInputs: DerivedPendingInput[];
} {
  let turnActive = false;

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "status") {
      turnActive = event.turnStatus === "started";
    } else if (event.type === "done") {
      turnActive = false;
    }
  }

  return {
    turnActive,
    pendingInputs: derivePendingInputRequests(events),
  };
}

type NativeControlState = {
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  unifiedPermissionMode: AgentChatUnifiedPermissionMode;
};

function defaultNativeControls(profile: ChatSurfaceProfile): NativeControlState {
  if (profile === "persistent_identity") {
    return {
      interactionMode: "default",
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      unifiedPermissionMode: "full-auto",
    };
  }
  return {
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    unifiedPermissionMode: "edit",
  };
}

function summarizeNativeControls(
  provider: AgentChatSessionSummary["provider"] | "claude" | "codex" | "unified",
  controls: NativeControlState,
): Pick<
  AgentChatSessionSummary,
  "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "unifiedPermissionMode" | "permissionMode"
> {
  if (provider === "claude") {
    let permissionMode: AgentChatSessionSummary["permissionMode"];
    if (controls.interactionMode === "plan") {
      permissionMode = "plan";
    } else if (controls.claudePermissionMode === "bypassPermissions") {
      permissionMode = "full-auto";
    } else if (controls.claudePermissionMode === "acceptEdits") {
      permissionMode = "edit";
    } else {
      permissionMode = controls.claudePermissionMode;
    }
    return {
      interactionMode: controls.interactionMode,
      claudePermissionMode: controls.claudePermissionMode,
      permissionMode,
    };
  }
  if (provider === "codex") {
    let permissionMode: AgentChatSessionSummary["permissionMode"];
    if (controls.codexConfigSource === "config-toml") {
      permissionMode = "config-toml";
    } else if (controls.codexApprovalPolicy === "never" && controls.codexSandbox === "danger-full-access") {
      permissionMode = "full-auto";
    } else if (controls.codexApprovalPolicy === "on-failure" && controls.codexSandbox === "workspace-write") {
      permissionMode = "edit";
    } else if (controls.codexApprovalPolicy === "untrusted" && controls.codexSandbox === "read-only") {
      permissionMode = "plan";
    }
    return {
      codexApprovalPolicy: controls.codexApprovalPolicy,
      codexSandbox: controls.codexSandbox,
      codexConfigSource: controls.codexConfigSource,
      ...(permissionMode ? { permissionMode } : {}),
    };
  }
  return {
    unifiedPermissionMode: controls.unifiedPermissionMode,
    permissionMode: controls.unifiedPermissionMode,
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

function sortSessionSummariesByRecency(
  rows: AgentChatSessionSummary[],
  localTouchBySession: ReadonlyMap<string, string>,
): AgentChatSessionSummary[] {
  return [...rows].sort((left, right) => compareChatSessionsByEffectiveRecency(left, right, localTouchBySession));
}

function byStartedDesc(a: AgentChatSessionSummary, b: AgentChatSessionSummary): number {
  return compareChatSessionsByEffectiveRecency(a, b, new Map());
}

export function resolveNextSelectedSessionId(args: {
  rows: AgentChatSessionSummary[];
  current: string | null;
  pendingSelectedSessionId: string | null;
  optimisticSessionIds: Set<string>;
  draftSelectionLocked: boolean;
  forceDraft: boolean;
  preferDraftStart: boolean;
}): string | null {
  const {
    rows,
    current,
    pendingSelectedSessionId,
    optimisticSessionIds,
    draftSelectionLocked,
    forceDraft,
    preferDraftStart,
  } = args;

  if (pendingSelectedSessionId) {
    const pendingIsPersisted = rows.some((row) => row.sessionId === pendingSelectedSessionId);
    if (pendingIsPersisted) return pendingSelectedSessionId;
    if (current === pendingSelectedSessionId || optimisticSessionIds.has(pendingSelectedSessionId)) {
      return pendingSelectedSessionId;
    }
  }

  if (!current && (draftSelectionLocked || forceDraft || preferDraftStart)) {
    return null;
  }
  if (current && rows.some((row) => row.sessionId === current)) {
    return current;
  }
  if (current && optimisticSessionIds.has(current)) {
    return current;
  }
  return rows[0]?.sessionId ?? null;
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
  const navigate = useNavigate();
  const selectLane = useAppStore((s) => s.selectLane);
  const lockedSingleSessionMode = Boolean(lockSessionId && hideSessionTabs && initialSessionSummary);
  const forceDraft = forceDraftMode || forceNewSession;
  const preferDraftStart = !lockSessionId && !initialSessionId && !forceNewSession;
  const surfaceProfile: ChatSurfaceProfile = presentation?.profile ?? "standard";
  const isPersistentIdentitySurface = surfaceProfile === "persistent_identity";
  const modelSwitchPolicy = presentation?.modelSwitchPolicy ?? "same-family-after-launch";
  const initialNativeControls = useMemo(() => defaultNativeControls(surfaceProfile), [surfaceProfile]);
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(lockSessionId ?? initialSessionId ?? null);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [turnActiveBySession, setTurnActiveBySession] = useState<Record<string, boolean>>({});
  const [pendingInputsBySession, setPendingInputsBySession] = useState<Record<string, DerivedPendingInput[]>>({});
  const [modelId, setModelId] = useState<string>("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<AgentChatExecutionMode>("focused");
  const [interactionMode, setInteractionMode] = useState<AgentChatInteractionMode>(initialNativeControls.interactionMode);
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [claudePermissionMode, setClaudePermissionMode] = useState<AgentChatClaudePermissionMode>(initialNativeControls.claudePermissionMode);
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<AgentChatCodexApprovalPolicy>(initialNativeControls.codexApprovalPolicy);
  const [codexSandbox, setCodexSandbox] = useState<AgentChatCodexSandbox>(initialNativeControls.codexSandbox);
  const [codexConfigSource, setCodexConfigSource] = useState<AgentChatCodexConfigSource>(initialNativeControls.codexConfigSource);
  const [unifiedPermissionMode, setUnifiedPermissionMode] = useState<AgentChatUnifiedPermissionMode>(initialNativeControls.unifiedPermissionMode);
  const [computerUsePolicy, setComputerUsePolicy] = useState<ComputerUsePolicy>(createDefaultComputerUsePolicy());
  const [providerConnections, setProviderConnections] = useState<{
    claude: AiProviderConnectionStatus | null;
    codex: AiProviderConnectionStatus | null;
  } | null>(null);
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [includeProjectDocs, setIncludeProjectDocs] = useState(false);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<import("../../../shared/types").AgentChatSlashCommand[]>([]);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [draft, setDraft] = useState("");
  const draftsPerSessionRef = useRef<Map<string | null, string>>(new Map());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [computerUseSnapshot, setComputerUseSnapshot] = useState<ComputerUseOwnerSnapshot | null>(null);
  const [proofDrawerOpen, setProofDrawerOpen] = useState(false);
  const [sessionDelta, setSessionDelta] = useState<{ insertions: number; deletions: number } | null>(null);
  const [sessionMutationKind, setSessionMutationKind] = useState<"model" | "permission" | "computer-use" | null>(null);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffModelId, setHandoffModelId] = useState("");

  const appliedInitialSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());
  const draftSelectionLockedRef = useRef(false);
  const optimisticSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingSelectedSessionIdRef = useRef<string | null>(null);
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
  const handoffRef = useRef<HTMLDivElement | null>(null);
  const localTouchBySessionRef = useRef<Map<string, string>>(new Map());
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
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;
  const activeProviderConnection = selectedSession?.provider === "claude"
    ? (providerConnections?.claude ?? null)
    : selectedSession?.provider === "codex"
      ? (providerConnections?.codex ?? null)
      : null;
  const pendingInput = selectedSessionId ? (pendingInputsBySession[selectedSessionId]?.[0] ?? null) : null;
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

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) {
      setInteractionMode(initialNativeControls.interactionMode);
      setClaudePermissionMode(initialNativeControls.claudePermissionMode);
      setCodexApprovalPolicy(initialNativeControls.codexApprovalPolicy);
      setCodexSandbox(initialNativeControls.codexSandbox);
      setCodexConfigSource(initialNativeControls.codexConfigSource);
      setUnifiedPermissionMode(initialNativeControls.unifiedPermissionMode);
      return;
    }
    const nextModelId = session.modelId ?? resolveRegistryModelId(session.model);
    if (nextModelId) {
      setModelId(nextModelId);
    }
    setReasoningEffort(session.reasoningEffort ?? null);
    setExecutionMode(session.executionMode ?? "focused");
    setInteractionMode(session.interactionMode ?? initialNativeControls.interactionMode);
    setClaudePermissionMode(session.claudePermissionMode ?? initialNativeControls.claudePermissionMode);
    setCodexApprovalPolicy(session.codexApprovalPolicy ?? initialNativeControls.codexApprovalPolicy);
    setCodexSandbox(session.codexSandbox ?? initialNativeControls.codexSandbox);
    setCodexConfigSource(session.codexConfigSource ?? initialNativeControls.codexConfigSource);
    setUnifiedPermissionMode(session.unifiedPermissionMode ?? initialNativeControls.unifiedPermissionMode);
    setComputerUsePolicy(session.computerUse ?? createDefaultComputerUsePolicy());
  }, [initialNativeControls]);
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
    || (surfaceMode === "resolver" ? "AI Resolver" : selectedSession ? chatSessionTitle(selectedSession) : "New chat");
  const assistantLabel = presentation?.assistantLabel?.trim()
    || resolveAssistantLabel(selectedModelDesc, selectedSession?.provider);
  const messagePlaceholder = presentation?.messagePlaceholder?.trim()
    || (assistantLabel === "Assistant" ? "Message the assistant..." : `Message ${assistantLabel}...`);
  const chipsJson = JSON.stringify(presentation?.chips ?? []);
  const resolvedChips = useMemo(() => JSON.parse(chipsJson) as ChatSurfaceChip[], [chipsJson]);

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
  const handoffAvailableModelIds = useMemo(() => {
    const merged = new Set<string>(availableModelIdsOverride?.length ? availableModelIdsOverride : availableModelIds);
    if (selectedSessionModelId) {
      merged.add(selectedSessionModelId);
    }
    return MODEL_REGISTRY
      .filter((model) => !model.deprecated && merged.has(model.id))
      .map((model) => model.id);
  }, [availableModelIds, availableModelIdsOverride, selectedSessionModelId]);
  const canShowHandoff = Boolean(
    lockSessionId
      && selectedSessionId
      && selectedSession
      && handoffAvailableModelIds.length > 0
      && surfaceMode === "standard"
      && !isPersistentIdentitySurface
      && (selectedSession.surface ?? "work") === "work",
  );
  const handoffBlocked = turnActive || Boolean(pendingInput) || handoffBusy;
  const handoffButtonTitle = handoffBlocked
    ? "Wait for the current output or approval to finish before handing off this chat."
    : "Create a new work chat on another model and seed it with a summary of this chat.";

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

  const refreshProviderConnections = useCallback(async () => {
    try {
      const status = await window.ade.ai.getStatus();
      setProviderConnections({
        claude: status.providerConnections?.claude ?? null,
        codex: status.providerConnections?.codex ?? null,
      });
    } catch {
      setProviderConnections(null);
    }
  }, []);

  const touchSession = useCallback((sessionId: string | null | undefined, touchedAt = new Date().toISOString()) => {
    if (!sessionId) return;
    const previousTouch = localTouchBySessionRef.current.get(sessionId);
    if (previousTouch && Date.parse(previousTouch) >= Date.parse(touchedAt)) {
      return;
    }
    localTouchBySessionRef.current.set(sessionId, touchedAt);
    setSessions((prev) => {
      if (!prev.some((session) => session.sessionId === sessionId)) return prev;
      const next = sortSessionSummariesByRecency(prev, localTouchBySessionRef.current);
      return next.every((session, index) => session.sessionId === prev[index]?.sessionId) ? prev : next;
    });
  }, []);

  const refreshSessions = useCallback(async () => {
    if (!laneId) {
      setSessions([]);
      return;
    }

    const rows = await window.ade.agentChat.list({ laneId });
    const nextRows = sortSessionSummariesByRecency(rows, localTouchBySessionRef.current);
    setSessions(nextRows);
    const nextSessionIds = new Set(nextRows.map((row) => row.sessionId));
    for (const sessionId of [...localTouchBySessionRef.current.keys()]) {
      if (!nextSessionIds.has(sessionId) && !optimisticSessionIdsRef.current.has(sessionId)) {
        localTouchBySessionRef.current.delete(sessionId);
      }
    }
    for (const row of nextRows) {
      // Don't clear the optimistic ID for the pending session — it needs to survive
      // until resolveNextSelectedSessionId actually selects it and clears the pending ref.
      if (row.sessionId !== pendingSelectedSessionIdRef.current) {
        optimisticSessionIdsRef.current.delete(row.sessionId);
      }
    }

    if (lockSessionId) {
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(lockSessionId);
      return;
    }

    setSelectedSessionId((current) => {
      const pendingSelectedSessionId = pendingSelectedSessionIdRef.current;
      const nextSelectedSessionId = resolveNextSelectedSessionId({
        rows: nextRows,
        current,
        pendingSelectedSessionId,
        optimisticSessionIds: optimisticSessionIdsRef.current,
        draftSelectionLocked: draftSelectionLockedRef.current,
        forceDraft,
        preferDraftStart,
      });
      if (pendingSelectedSessionId && nextRows.some((row) => row.sessionId === pendingSelectedSessionId)) {
        pendingSelectedSessionIdRef.current = null;
      }
      return nextSelectedSessionId;
    });
  }, [forceDraft, laneId, lockSessionId, preferDraftStart]);

  // Save/restore per-session drafts when switching sessions
  const prevSessionIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevSessionIdRef.current !== undefined) {
      // Save draft for the session we're leaving
      draftsPerSessionRef.current.set(prevSessionIdRef.current, draft);
    }
    prevSessionIdRef.current = selectedSessionId;
    // Restore draft for the session we're entering
    const saved = draftsPerSessionRef.current.get(selectedSessionId) ?? "";
    setDraft(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only trigger on session switch, not draft changes
  }, [selectedSessionId]);

  useEffect(() => {
    void refreshProviderConnections();
  }, [refreshProviderConnections, selectedSession?.provider]);

  useEffect(() => {
    if (!turnActive || !selectedSession?.provider) return;
    const timer = window.setInterval(() => {
      void refreshProviderConnections();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshProviderConnections, selectedSession?.provider, turnActive]);

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
      setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: derived.pendingInputs }));
    } catch {
      // Ignore transcript history failures.
    }
  }, []);

  const clearSessionView = useCallback((sessionId: string) => {
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: [] };
    setEventsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: [] }));
  }, []);

  useEffect(() => {
    if (lockSessionId) {
      pendingSelectedSessionIdRef.current = null;
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
    pendingSelectedSessionIdRef.current = null;
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(nextInitialSessionId);
  }, [initialSessionId, lockSessionId]);

  useEffect(() => {
    draftSelectionLockedRef.current = false;
    optimisticSessionIdsRef.current.clear();
    pendingSelectedSessionIdRef.current = null;
    appliedInitialSessionIdRef.current = initialSessionId ?? null;
    if (forceDraft && !lockSessionId) {
      draftSelectionLockedRef.current = true;
      setSelectedSessionId(null);
    }
  }, [forceDraft, laneId, lockSessionId]);

  useEffect(() => {
    if (!forceDraft || lockSessionId) return;
    pendingSelectedSessionIdRef.current = null;
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

  useClickOutside(handoffRef, () => setHandoffOpen(false), handoffOpen);

  useEffect(() => {
    if (!handoffOpen) return;
    const preferredTargetId = handoffAvailableModelIds.find((id) => id !== selectedSessionModelId) ?? handoffAvailableModelIds[0] ?? "";
    setHandoffModelId((current) => {
      if (current && handoffAvailableModelIds.includes(current)) {
        return current;
      }
      return preferredTargetId;
    });
  }, [handoffAvailableModelIds, handoffOpen, selectedSessionModelId]);

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
    setPromptSuggestion(null);
    setHandoffOpen(false);
    setHandoffBusy(false);
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

  // Fetch git diff stats when the session changes or a turn completes
  useEffect(() => {
    if (!selectedSessionId) { setSessionDelta(null); return; }
    let cancelled = false;
    const fetchDelta = () => {
      window.ade.sessions.getDelta(selectedSessionId)
        .then((delta) => {
          if (cancelled) return;
          if (delta && (delta.insertions > 0 || delta.deletions > 0)) {
            setSessionDelta({ insertions: delta.insertions, deletions: delta.deletions });
          } else {
            setSessionDelta(null);
          }
        })
        .catch(() => { if (!cancelled) setSessionDelta(null); });
    };
    fetchDelta();
    return () => { cancelled = true; };
  }, [selectedSessionId, turnActive]);

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
    const pendingInputPatch: Record<string, DerivedPendingInput[]> = {};
    for (const sessionId of touchedSessionIds) {
      const derived = deriveRuntimeState(next[sessionId] ?? []);
      activePatch[sessionId] = derived.turnActive;
      pendingInputPatch[sessionId] = derived.pendingInputs;
    }

    // All three setters fire synchronously — React 18 batches them into one render.
    setEventsBySession(next);
    setTurnActiveBySession((activePrev) => ({ ...activePrev, ...activePatch }));
    setPendingInputsBySession((pendingPrev) => ({ ...pendingPrev, ...pendingInputPatch }));
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
      const touchTimestamp = getChatSessionLocalTouchTimestampForEvent(envelope);
      if (touchTimestamp) {
        touchSession(envelope.sessionId, touchTimestamp);
      }

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

      // Wire prompt_suggestion events to state
      if (envelope.event.type === "prompt_suggestion" && "suggestion" in envelope.event) {
        if (envelope.sessionId === selectedSessionIdRef.current) {
          setPromptSuggestion((envelope.event as any).suggestion);
        }
      }

      // Clear prompt suggestion when a new turn starts
      if (envelope.event.type === "status" && envelope.event.turnStatus === "started") {
        if (envelope.sessionId === selectedSessionIdRef.current) {
          setPromptSuggestion(null);
        }
      }

      if (shouldRefreshSessionListForChatEvent(envelope)) {
        scheduleSessionsRefresh();
      }

      const shouldRefreshSlashCommands =
        envelope.event.type === "done"
        || (
          envelope.event.type === "system_notice"
          && (
            envelope.event.noticeKind === "auth"
            || envelope.event.message === "Session ready"
          )
        );

      if (shouldRefreshSlashCommands) {
        if (envelope.sessionId === selectedSessionIdRef.current) {
          window.ade.agentChat.slashCommands({ sessionId: envelope.sessionId })
            .then(setSdkSlashCommands)
            .catch(() => {});
        }
      }
    });
    return unsubscribe;
  }, [lockSessionId, flushQueuedEvents, scheduleQueuedEventFlush, scheduleSessionsRefresh, touchSession]);

  useEffect(() => {
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      if (!selectedSessionId) return;
      if (event.owner?.kind === "chat_session" && event.owner.id === selectedSessionId) {
        setProofDrawerOpen(true);
        void refreshComputerUseSnapshot(selectedSessionId, { force: true });
      }
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

  useEffect(() => {
    if (!selectedSessionId) {
      setProofDrawerOpen(false);
    }
  }, [selectedSessionId]);

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
    setSessions((prev) => {
      const next = prev.map((session) => (
        session.sessionId === sessionId ? { ...session, ...patch } : session
      ));
      return sortSessionSummariesByRecency(next, localTouchBySessionRef.current);
    });
  }, []);

  const currentNativeControls = useMemo<NativeControlState>(() => ({
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    unifiedPermissionMode,
  }), [
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    unifiedPermissionMode,
  ]);
  const nativeControlsRef = useRef<NativeControlState>(currentNativeControls);
  useEffect(() => {
    nativeControlsRef.current = currentNativeControls;
  }, [currentNativeControls]);

  const buildNativeControlPayload = useCallback((provider: "claude" | "codex" | "unified") => {
    return summarizeNativeControls(provider, currentNativeControls);
  }, [currentNativeControls]);
  const buildModelSelectionSnapshot = useCallback((nextModelId: string) => {
    const nextDesc = getModelById(nextModelId);
    const nextProvider: "claude" | "codex" | "unified" = nextDesc?.isCliWrapped
      ? (nextDesc.family === "openai" ? "codex" : "claude")
      : "unified";
    const nextModel = nextProvider === "unified" ? nextModelId : (nextDesc?.shortId ?? nextModelId);
    const tiers = nextDesc?.reasoningTiers ?? [];
    const preferred = readLastUsedReasoningEffort({ laneId, modelId: nextModelId });
    const nextReasoningEffort = selectReasoningEffort({ tiers, preferred });
    return {
      nextDesc,
      nextModelId,
      nextModel,
      nextProvider,
      nextReasoningEffort,
    };
  }, [laneId]);
  const applyModelSelectionSnapshot = useCallback((snapshot: {
    nextModelId: string;
    nextReasoningEffort: string | null;
  }) => {
    setModelId(snapshot.nextModelId);
    setReasoningEffort(snapshot.nextReasoningEffort);
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
      const sessionProfile = resolveChatSessionProfile(computerUsePolicy);
      const created = await window.ade.agentChat.create({
        laneId,
        provider,
        model,
        modelId,
        sessionProfile,
        reasoningEffort,
        ...buildNativeControlPayload(provider),
        computerUse: computerUsePolicy,
      });
      loadedHistoryRef.current.delete(created.id);
      optimisticSessionIdsRef.current.add(created.id);
      pendingSelectedSessionIdRef.current = created.id;
      draftSelectionLockedRef.current = false;
      touchSession(created.id);
      setSelectedSessionId(created.id);
      // Fire-and-forget: don't block session creation on the parent opening the tab.
      // Blocking here caused a race where work.refresh() would re-resolve selection
      // before the new session was indexed, routing the user to an old chat.
      void onSessionCreated?.(created.id);
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
  }, [buildNativeControlPayload, computerUsePolicy, laneId, modelId, onSessionCreated, reasoningEffort, refreshSessions, touchSession]);

  const handoffSession = useCallback(async () => {
    if (!canShowHandoff || !selectedSessionId || !handoffModelId || handoffBlocked) return;
    setError(null);
    setHandoffBusy(true);
    try {
      const result = await window.ade.agentChat.handoff({
        sourceSessionId: selectedSessionId,
        targetModelId: handoffModelId,
      });
      setHandoffOpen(false);
      await onSessionCreated?.(result.session.id);
      void refreshSessions().catch(() => {});
    } catch (handoffError) {
      setError(handoffError instanceof Error ? handoffError.message : String(handoffError));
    } finally {
      setHandoffBusy(false);
    }
  }, [canShowHandoff, handoffBlocked, handoffModelId, onSessionCreated, refreshSessions, selectedSessionId]);

  // ── Eager session creation ──
  // Create a session as soon as we have a model + lane, so slash commands,
  // MCP status, and other pre-chat metadata are available immediately.
  // Computer-use-capable chats start as workflow sessions so ADE can wire the
  // Ghost/proof harness before the first turn.
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
    setDraft("");
    draftsPerSessionRef.current.delete(selectedSessionId);
    setAttachments([]);
    try {
      let justCreatedSession = false;
      let finalText = text;

      // Prepend project context docs if the user toggled the checkbox
      if (!isLiteralSlashCommand && includeProjectDocs) {
        const docPaths = [".ade/context/PRD.ade.md", ".ade/context/ARCHITECTURE.ade.md"];
        const docNote = [
          "[Project Context — generated from main branch, may not reflect in-progress lane work]",
          "The following project-level docs are available for reference. Read them with read_file if you need project context:",
          ...docPaths.map((p) => `- ${p}`),
        ].join("\n");
        finalText = `${docNote}\n\n---\n\n${finalText}`;
        setIncludeProjectDocs(false);
      }

      let sessionId = selectedSessionId;
      const shouldPromoteLightSession = shouldPromoteSessionForComputerUse(selectedSession, computerUsePolicy);
      const selectedModelChanged =
        Boolean(selectedSessionId)
        && Boolean(selectedSessionModelId)
        && selectedSessionModelId !== modelId;

      if (sessionId && !turnActive && (selectedModelChanged || hasComputerUseSelectionChanged || shouldPromoteLightSession)) {
        const desc = getModelById(modelId);
        const provider = desc?.isCliWrapped
          ? (desc.family === "openai" ? "codex" : "claude")
          : "unified";
        await window.ade.agentChat.updateSession({
          sessionId,
          modelId,
          reasoningEffort,
          ...buildNativeControlPayload(provider),
          computerUse: computerUsePolicy,
        });
        await refreshSessions();
      } else if (!sessionId) {
        // No session yet — create one
        sessionId = await createSession();
        justCreatedSession = true;
      }
      if (!sessionId) {
        throw new Error("Unable to create chat session.");
      }

      touchSession(sessionId);

      const selectedAttachments = isLiteralSlashCommand ? [] : attachmentsSnapshot;
      const steerText = selectedAttachments.length
        ? `${finalText}\n\nAttached context:\n${selectedAttachments.map((entry) => `- ${entry.type}: ${entry.path}`).join("\n")}`
        : finalText;
      if (turnActiveBySession[sessionId]) {
        await window.ade.agentChat.steer({ sessionId, text: steerText });
      } else {
        try {
          await window.ade.agentChat.send({
            sessionId,
            text: finalText,
            displayText: text,
            attachments: selectedAttachments,
            reasoningEffort,
            executionMode: launchModeEditable ? executionMode : null,
            interactionMode: sessionProvider === "claude" ? interactionMode : null,
          });
        } catch (sendError) {
          // Race condition: the turn may have started between our state check
          // and the backend call. If so, automatically fall back to steer
          // instead of surfacing a confusing error to the user.
          const sendMsg = sendError instanceof Error ? sendError.message : String(sendError);
          const isBusy = /turn is already active|already active/i.test(sendMsg);
          if (isBusy) {
            await window.ade.agentChat.steer({ sessionId, text: steerText });
          } else {
            throw sendError;
          }
        }
      }
      // Skip refresh when we just created the session — createSession already triggered one.
      // A redundant refresh here causes flicker as it re-resolves session selection.
      if (!justCreatedSession) {
        await refreshSessions().catch(() => {});
      }
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setDraft((current) => (current.trim().length ? current : draftSnapshot));
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setError(message);
      if (
        /ade chat could not authenticate/i.test(message)
        || /not authenticated/i.test(message)
        || /login required/i.test(message)
      ) {
        void refreshAvailableModels().catch(() => {});
      }
    } finally {
      submitInFlightRef.current = false;
      setBusy(false);
    }
  }, [
    attachments,
    buildNativeControlPayload,
    busy,
    createSession,
    computerUsePolicy,
    draft,
    executionMode,
    hasComputerUseSelectionChanged,
    includeProjectDocs,
    interactionMode,
    laneId,
    launchModeEditable,
    modelId,
    reasoningEffort,
    refreshSessions,
    selectedEvents.length,
    selectedSessionId,
    selectedSessionModelId,
    sessionProvider,
    touchSession,
    turnActive,
    turnActiveBySession
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedSessionId) return;
    try {
      touchSession(selectedSessionId);
      await window.ade.agentChat.interrupt({ sessionId: selectedSessionId });
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError));
    }
  }, [selectedSessionId, touchSession]);

  const approve = useCallback(async (
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => {
    if (!selectedSessionId) return;
    const request = pendingInputsBySession[selectedSessionId]?.[0];
    if (!request) return;
    try {
      touchSession(selectedSessionId);
      await window.ade.agentChat.respondToInput({
        sessionId: selectedSessionId,
        itemId: request.itemId,
        decision,
        responseText,
        ...(answers ? { answers } : {}),
      });
      setPendingInputsBySession((prev) => ({
        ...prev,
        [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((entry) => entry.itemId !== request.itemId)
      }));
    } catch (approvalError) {
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    }
  }, [pendingInputsBySession, selectedSessionId, touchSession]);

  const updateNativeControls = useCallback(async (patch: Partial<NativeControlState>) => {
    if (isPersistentIdentitySurface && sessionMutationKind) return;

    const nextControls: NativeControlState = {
      ...nativeControlsRef.current,
      ...patch,
    };
    nativeControlsRef.current = nextControls;

    setInteractionMode(nextControls.interactionMode);
    setClaudePermissionMode(nextControls.claudePermissionMode);
    setCodexApprovalPolicy(nextControls.codexApprovalPolicy);
    setCodexSandbox(nextControls.codexSandbox);
    setCodexConfigSource(nextControls.codexConfigSource);
    setUnifiedPermissionMode(nextControls.unifiedPermissionMode);

    if (!selectedSessionId) return;

    const provider = selectedSession?.provider ?? sessionProvider;
    const nextSummary = summarizeNativeControls(provider, nextControls);
    patchSessionSummary(selectedSessionId, nextSummary);
    if (isPersistentIdentitySurface) {
      setSessionMutationKind("permission");
    }

    try {
      await window.ade.agentChat.updateSession({
        sessionId: selectedSessionId,
        ...nextSummary,
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
  }, [
    isPersistentIdentitySurface,
    patchSessionSummary,
    refreshSessions,
    selectedSession,
    selectedSessionId,
    sessionMutationKind,
    sessionProvider,
  ]);
  const handleClaudeModeChange = useCallback((mode: AgentChatClaudePermissionMode) => {
    void updateNativeControls({
      interactionMode: mode === "plan" ? "plan" : "default",
      claudePermissionMode: mode,
    });
  }, [updateNativeControls]);

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
          <div className="font-sans text-[13px] font-semibold text-fg/50">
            {resolvedTitle}
          </div>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {laneId && laneDisplayLabel && laneDisplayLabel !== laneId ? (
            <button
              type="button"
              className="inline-flex items-center gap-1.5 rounded-md border border-white/[0.06] px-2 py-1 font-sans text-[11px] font-medium text-muted-fg/50 transition-colors hover:border-white/[0.1] hover:text-fg/70"
              title={`Go to lane: ${laneDisplayLabel}`}
              onClick={() => {
                selectLane(laneId);
                navigate(`/lanes?laneId=${encodeURIComponent(laneId)}`);
              }}
            >
              <GitBranch size={11} weight="regular" />
              <span className="max-w-[140px] truncate">{laneDisplayLabel}</span>
            </button>
          ) : null}
          {canShowHandoff ? (
            <div ref={handoffRef} className="relative">
              <button
                type="button"
                className="inline-flex items-center rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] font-medium text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setError(null);
                  setHandoffOpen((current) => !current);
                }}
                disabled={handoffBlocked}
                title={handoffButtonTitle}
              >
                Chat handoff
              </button>
              {handoffOpen ? (
                <div className="absolute right-0 top-full z-30 mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-xl border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,20,28,0.98),rgba(10,12,18,0.98))] p-3 shadow-[0_24px_90px_-40px_rgba(0,0,0,0.88)] backdrop-blur-xl">
                  <div className="space-y-1">
                    <div className="font-sans text-[12px] font-semibold text-fg/82">Start a sibling chat on another model</div>
                    <div className="text-[11px] leading-5 text-fg/54">
                      ADE will create a new work chat, inject a handoff summary from this session, and route you into the new tab.
                    </div>
                  </div>
                  <div className="mt-3">
                    <UnifiedModelSelector
                      value={handoffModelId}
                      onChange={setHandoffModelId}
                      availableModelIds={handoffAvailableModelIds}
                      showReasoning={false}
                    />
                  </div>
                  <div className="mt-3 flex items-center justify-end gap-2">
                    <button
                      type="button"
                      className="rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg"
                      onClick={() => setHandoffOpen(false)}
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      className="rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] px-2.5 py-1 font-sans text-[11px] font-medium text-fg/86 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
                      onClick={() => {
                        void handoffSession();
                      }}
                      disabled={!handoffModelId || handoffBusy}
                    >
                      {handoffBusy ? "Starting..." : "Create handoff chat"}
                    </button>
                  </div>
                </div>
              ) : null}
            </div>
          ) : null}
          {isPersistentIdentitySurface && selectedSessionId ? (
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-white/[0.06] px-2.5 py-1 font-sans text-[11px] font-medium text-muted-fg/60 transition-colors hover:border-white/[0.1] hover:text-fg"
              onClick={() => {
                clearSessionView(selectedSessionId);
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
        </div>
      </div>

      {!lockSessionId && !hideSessionTabs ? (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
            {sessions.map((session) => {
              const title = chatSessionTitle(session);
              const isActive = session.sessionId === selectedSessionId;
              const isRunning = turnActiveBySession[session.sessionId] ?? false;
              const sessionNeedsInput = Boolean(pendingInputsBySession[session.sessionId]?.length);
              const sessionIndicatorStatus = sessionNeedsInput ? "waiting" : isRunning ? "working" : null;
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
                    pendingSelectedSessionIdRef.current = null;
                    draftSelectionLockedRef.current = false;
                    syncComposerToSession(session);
                    touchSession(session.sessionId);
                    setSelectedSessionId(session.sessionId);
                  }}
                >
                  <ToolLogo toolType={chatToolTypeForProvider(session.provider)} size={10} />
                  <span className="max-w-[120px] truncate">{title}</span>
                  {session.completion ? (
                    <span
                      className={cn(
                        "inline-flex items-center rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-[0.12em]",
                        completionBadgeClass(session.completion.status),
                      )}
                    >
                      {session.completion.status}
                    </span>
                  ) : null}
                  {sessionIndicatorStatus ? (
                    <span
                      aria-label={sessionIndicatorStatus === "working" ? "Agent working" : "Waiting for your input"}
                      title={sessionIndicatorStatus === "working" ? "Agent working" : "Waiting for your input"}
                      className="inline-flex h-3.5 w-3.5 items-center justify-center"
                    >
                      <ChatStatusGlyph status={sessionIndicatorStatus} size={11} />
                    </span>
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
              pendingSelectedSessionIdRef.current = null;
              draftSelectionLockedRef.current = true;
              setError(null);
              setSelectedSessionId(null);
              setDraft("");
              setAttachments([]);
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
            sdkSlashCommands={sdkSlashCommands}
            modelId={modelId}
            availableModelIds={effectiveAvailableModelIds}
            reasoningEffort={reasoningEffort}
            draft={draft}
            attachments={attachments}
            pendingInput={pendingInput?.request ?? null}
            turnActive={turnActive}
            sendOnEnter={sendOnEnter}
            busy={busy}
            sessionProvider={sessionProvider}
            interactionMode={interactionMode}
            claudePermissionMode={claudePermissionMode}
            codexApprovalPolicy={codexApprovalPolicy}
            codexSandbox={codexSandbox}
            codexConfigSource={codexConfigSource}
            unifiedPermissionMode={unifiedPermissionMode}
            executionMode={selectedExecutionMode?.value ?? "focused"}
            computerUsePolicy={computerUsePolicy}
            computerUseSnapshot={computerUseSnapshot}
            proofOpen={proofDrawerOpen}
            proofArtifactCount={computerUseSnapshot?.artifacts.length ?? 0}
            executionModeOptions={launchModeEditable ? executionModeOptions : []}
            modelSelectionLocked={modelSelectionLocked || sessionMutationKind === "model" || turnActive}
            permissionModeLocked={permissionModeLocked || identitySessionSettingsBusy}
            messagePlaceholder={messagePlaceholder}
            onExecutionModeChange={setExecutionMode}
            onInteractionModeChange={(value) => { void updateNativeControls({ interactionMode: value }); }}
            onClaudeModeChange={handleClaudeModeChange}
            onClaudePermissionModeChange={(value) => { void updateNativeControls({ claudePermissionMode: value }); }}
            onCodexPresetChange={(next) => { void updateNativeControls(next); }}
            onCodexApprovalPolicyChange={(value) => { void updateNativeControls({ codexApprovalPolicy: value }); }}
            onCodexSandboxChange={(value) => { void updateNativeControls({ codexSandbox: value }); }}
            onCodexConfigSourceChange={(value) => { void updateNativeControls({ codexConfigSource: value }); }}
            onUnifiedPermissionModeChange={(value) => { void updateNativeControls({ unifiedPermissionMode: value }); }}
            onComputerUsePolicyChange={handleComputerUsePolicyChange}
            onToggleProof={() => setProofDrawerOpen((current) => !current)}
            onModelChange={(nextModelId) => {
              if (selectedSessionModelId && effectiveAvailableModelIds.length && !effectiveAvailableModelIds.includes(nextModelId)) {
                return;
              }
              if (isPersistentIdentitySurface && sessionMutationKind) {
                return;
              }
              const snapshot = buildModelSelectionSnapshot(nextModelId);
              if (!selectedSessionId || turnActive) {
                applyModelSelectionSnapshot(snapshot);
                if (selectedSessionId && snapshot.nextDesc?.family === "anthropic" && snapshot.nextDesc.isCliWrapped) {
                  window.ade.agentChat.warmupModel({
                    sessionId: selectedSessionId,
                    modelId: nextModelId,
                  }).catch(() => { /* warmup is best-effort */ });
                }
                return;
              }

              setSessionMutationKind("model");
              void window.ade.agentChat.updateSession({
                sessionId: selectedSessionId,
                modelId: nextModelId,
                reasoningEffort: snapshot.nextReasoningEffort,
                ...buildNativeControlPayload(snapshot.nextProvider),
                computerUse: computerUsePolicy,
              }).then((updatedSession) => {
                applyModelSelectionSnapshot(snapshot);
                patchSessionSummary(selectedSessionId, {
                  provider: updatedSession.provider,
                  model: updatedSession.model,
                  modelId: updatedSession.modelId,
                  reasoningEffort: updatedSession.reasoningEffort ?? null,
                  permissionMode: updatedSession.permissionMode,
                  interactionMode: updatedSession.interactionMode ?? null,
                  claudePermissionMode: updatedSession.claudePermissionMode,
                  codexApprovalPolicy: updatedSession.codexApprovalPolicy,
                  codexSandbox: updatedSession.codexSandbox,
                  codexConfigSource: updatedSession.codexConfigSource,
                  unifiedPermissionMode: updatedSession.unifiedPermissionMode,
                  computerUse: updatedSession.computerUse,
                });
                window.ade.agentChat.slashCommands({ sessionId: selectedSessionId })
                  .then(setSdkSlashCommands)
                  .catch(() => {});
                if (snapshot.nextDesc?.family === "anthropic" && snapshot.nextDesc.isCliWrapped) {
                  window.ade.agentChat.warmupModel({
                    sessionId: selectedSessionId,
                    modelId: nextModelId,
                  }).catch(() => { /* warmup is best-effort */ });
                }
                void refreshSessions().catch(() => {});
              }).catch((err) => {
                void refreshSessions().catch(() => {});
                setError(err instanceof Error ? err.message : String(err));
              }).finally(() => {
                setSessionMutationKind(null);
              });
            }}
            onReasoningEffortChange={setReasoningEffort}
            onDraftChange={(value) => {
              setDraft(value);
              draftsPerSessionRef.current.set(selectedSessionId, value);
              if (value.length > 0) setPromptSuggestion(null);
            }}
            onClearDraft={() => setDraft("")}
            onSubmit={() => {
              setPromptSuggestion(null);
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
            includeProjectDocs={includeProjectDocs}
            onIncludeProjectDocsChange={setIncludeProjectDocs}
            onClearEvents={() => {
              if (selectedSessionId) {
                clearSessionView(selectedSessionId);
              }
            }}
            promptSuggestion={promptSuggestion}
            subagentSnapshots={selectedSubagentSnapshots}
            chatHasMessages={selectedEvents.length > 0}
          />
        }
        bodyClassName="flex min-h-0 flex-col overflow-hidden"
      >
        {error ? (
          <div className="border-b border-red-500/10 px-4 py-2 font-mono text-[10px] text-red-300/80">
            {error}
          </div>
        ) : null}
        {selectedSessionId && activeProviderConnection?.blocker && !activeProviderConnection.runtimeAvailable ? (
          <div className="border-b border-amber-500/10 bg-amber-500/[0.04] px-4 py-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200/70">
              {activeProviderConnection.provider === "claude" ? "Claude runtime" : "Codex runtime"}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-amber-100/80">
              {activeProviderConnection.blocker}
            </div>
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
                      <div className="mt-1 text-[11px] text-fg/54">
                        Inspect retained screenshots, traces, logs, and verification output for this chat.
                      </div>
                    </div>
                    <button
                      type="button"
                      className="rounded-[var(--chat-radius-pill)] border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-sans text-[11px] font-medium text-fg/58 transition-colors hover:text-fg/82"
                      onClick={() => setProofDrawerOpen(false)}
                      title="Hide proof drawer"
                    >
                      Hide proof
                    </button>
                  </div>
                  <div className="max-h-[48vh] overflow-auto px-4 pb-4">
                    <ChatComputerUsePanel
                      sessionId={selectedSessionId}
                      snapshot={computerUseSnapshot}
                      onRefresh={() => refreshComputerUseSnapshot(selectedSessionId, { force: true })}
                    />
                  </div>
                </div>
              ) : null}
              <AgentChatMessageList
                key={selectedSessionId ?? "chat-draft"}
                events={selectedEvents}
                showStreamingIndicator={turnActive}
                className="min-h-0 border-0"
                surfaceMode={surfaceMode}
                surfaceProfile={surfaceProfile}
                assistantLabel={assistantLabel}
                onApproval={(itemId, decision, responseText) => {
                  if (!selectedSessionId) return;
                  touchSession(selectedSessionId);
                  window.ade.agentChat.respondToInput({ sessionId: selectedSessionId, itemId, decision, responseText }).then(() => {
                    setPendingInputsBySession((prev) => ({
                      ...prev,
                      [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((e) => e.itemId !== itemId)
                    }));
                  }).catch((err) => {
                    setError(err instanceof Error ? err.message : String(err));
                  });
                }}
              />
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
      {pendingInput && selectedSessionId && (pendingInput.request.kind === "question" || pendingInput.request.kind === "structured_question") ? (
        <AgentQuestionModal
          request={pendingInput.request}
          onClose={() => {
            void approve("cancel");
          }}
          onSubmit={({ answers, responseText }) => {
            void approve("accept", responseText, answers);
          }}
          onDecline={() => {
            void approve("decline");
          }}
        />
      ) : null}
    </>
  );
}
