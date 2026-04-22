import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { GitBranch, Plus } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatCursorConfigValue,
  type AgentChatExecutionMode,
  type AgentChatEventEnvelope,
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AiProviderConnectionStatus,
  type AiRuntimeConnectionStatus,
  type AgentChatSession,
  type AgentChatOpenCodePermissionMode,
  type AgentChatSessionProfile,
  type ChatSurfaceChip,
  type ChatSurfaceProfile,
  type ChatSurfacePresentation,
  type AgentChatSessionSummary,
  type ComputerUseOwnerSnapshot,
  type AiSettingsStatus,
  type TerminalToolType,
} from "../../../shared/types";
import { parseAgentChatTranscript } from "../../../shared/chatTranscript";
import { isProviderSlashCommandInput } from "../../../shared/chatSlashCommands";
import {
  LOCAL_PROVIDER_LABELS,
  MODEL_REGISTRY,
  decodeOpenCodeRegistryId,
  getLocalModelIdTail,
  getLocalProviderDefaultEndpoint,
  getModelById,
  getModelDescriptorForPermissionMode,
  parseLocalProviderFromModelId,
  resolveModelDescriptorForProvider,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { CURSOR_AVAILABLE_MODE_IDS } from "../../../shared/cursorModes";
import { cn } from "../ui/cn";
import { AgentChatComposer } from "./AgentChatComposer";
import { AgentChatMessageList } from "./AgentChatMessageList";
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
import { chatChipToneClass, providerChatAccent } from "./chatSurfaceTheme";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import { ChatTasksPanel } from "./ChatTasksPanel";
import { ChatFileChangesPanel } from "./ChatFileChangesPanel";
import { ChatGitToolbar } from "./ChatGitToolbar";
import { ChatTerminalDrawer, ChatTerminalToggle } from "./ChatTerminalDrawer";
import { deriveChatSubagentSnapshots, deriveTodoItems, deriveTurnDiffSummaries } from "./chatExecutionSummary";
import { derivePendingInputRequests, type DerivedPendingInput } from "./pendingInput";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { useClickOutside } from "../../hooks/useClickOutside";
import { DEFAULT_CHAT_FONT_SIZE_PX, useAppStore } from "../../state/appStore";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import { getAgentChatModelsCached, getAiStatusCached } from "../../lib/aiDiscoveryCache";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";

const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;
const CHAT_HISTORY_READ_MAX_BYTES = 900_000;
const MAX_RETAINED_CHAT_SESSION_HISTORIES = 6;
const MAX_SELECTED_CHAT_SESSION_EVENTS = 1_200;
const MAX_BACKGROUND_CHAT_SESSION_EVENTS = 240;

type AiStatusSnapshot = AiSettingsStatus & {
  runtimeConnections?: Record<string, AiRuntimeConnectionStatus>;
};

function formatLocalModelLabel(modelId: string): string {
  const provider = parseLocalProviderFromModelId(modelId);
  if (!provider) {
    return getModelById(modelId)?.displayName ?? modelId;
  }
  const tail = getLocalModelIdTail(modelId, provider);
  return tail.length ? tail : modelId;
}

function recommendedOpenCodePermissionModeForModel(
  descriptor: ModelDescriptor | null | undefined,
): AgentChatOpenCodePermissionMode | null {
  if (!descriptor?.authTypes.includes("local")) return null;
  return descriptor.harnessProfile === "guarded" || descriptor.harnessProfile === "read_only"
    ? "plan"
    : null;
}

function shouldResetOpenCodePermissionForModelSwitch(
  previous: ModelDescriptor | null | undefined,
  next: ModelDescriptor | null | undefined,
): boolean {
  const prevRec = recommendedOpenCodePermissionModeForModel(previous);
  const nextRec = recommendedOpenCodePermissionModeForModel(next);
  if (prevRec == null && nextRec == null) return false;
  return prevRec !== nextRec;
}

type LocalRuntimeNoticeShape = {
  tone: "success" | "warning";
  title: string;
  message: string;
};

function LocalRuntimeNoticeBlock(props: {
  notice: LocalRuntimeNoticeShape;
  endpoint?: string | null;
  /** `inline` = text only (inside a parent runtime card). */
  variant?: "card" | "inline";
}) {
  const { notice, endpoint, variant = "card" } = props;
  const isCard = variant === "card";
  return (
    <div
      className={cn(
        isCard && "border-b px-4 py-2.5",
        isCard && (notice.tone === "success"
          ? "border-emerald-500/10 bg-emerald-500/[0.04]"
          : "border-amber-500/10 bg-amber-500/[0.04]"),
      )}
    >
      <div className={cn(
        "font-mono text-[10px] uppercase tracking-[0.16em]",
        notice.tone === "success" ? "text-emerald-200/70" : "text-amber-200/70",
      )}>
        {notice.title}
      </div>
      <div className={cn(
        "mt-1 text-[12px] leading-5",
        notice.tone === "success" ? "text-emerald-100/80" : "text-amber-100/80",
      )}>
        {notice.message}
      </div>
      {endpoint ? (
        <code className="mt-2 block rounded-md border border-white/[0.06] bg-black/10 px-2 py-1 font-mono text-[10px] text-fg/60">
          {endpoint}
        </code>
      ) : null}
    </div>
  );
}

export function resolveChatSessionProfile(): AgentChatSessionProfile {
  return "workflow";
}

export function shouldPromoteSessionForComputerUse(
  session: Pick<AgentChatSessionSummary, "sessionProfile"> | null | undefined,
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

export type PendingSteerEntry = {
  steerId: string;
  text: string;
};

export function deriveRuntimeState(events: AgentChatEventEnvelope[]): {
  turnActive: boolean;
  pendingInputs: DerivedPendingInput[];
  pendingSteers: PendingSteerEntry[];
} {
  let turnActive = false;

  // Track pending steers: added on queued user_message, removed on cancel/deliver notices
  const steerMap = new Map<string, PendingSteerEntry>();
  const resolvedSteerIds = new Set<string>();

  for (const envelope of events) {
    const event = envelope.event;
    if (event.type === "status") {
      turnActive = event.turnStatus === "started";
    } else if (event.type === "done") {
      turnActive = false;
    } else if (event.type === "user_message" && event.steerId && event.deliveryState === "queued") {
      if (!resolvedSteerIds.has(event.steerId)) {
        steerMap.set(event.steerId, { steerId: event.steerId, text: event.text });
      }
    } else if (event.type === "system_notice" && event.steerId) {
      // "cancelled" or "Delivering" notices resolve the steer
      if (/cancelled|delivering/i.test(event.message)) {
        steerMap.delete(event.steerId);
        resolvedSteerIds.add(event.steerId);
      }
    }
  }

  return {
    turnActive,
    pendingInputs: derivePendingInputRequests(events),
    pendingSteers: Array.from(steerMap.values()),
  };
}

type NativeControlState = {
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  cursorModeId: string | null;
  cursorConfigValues: Record<string, AgentChatCursorConfigValue>;
};

function defaultNativeControls(profile: ChatSurfaceProfile): NativeControlState {
  if (profile === "persistent_identity") {
    return {
      interactionMode: "default",
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      opencodePermissionMode: "full-auto",
      cursorModeId: "agent",
      cursorConfigValues: {},
    };
  }
  return {
    interactionMode: "default",
    claudePermissionMode: "default",
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
    opencodePermissionMode: "edit",
    cursorModeId: "agent",
    cursorConfigValues: {},
  };
}

type ChatRuntimeProviderKey = "claude" | "codex" | "cursor" | "opencode";

function resolveChatRuntimeProvider(desc: ModelDescriptor | null | undefined): ChatRuntimeProviderKey {
  if (!desc?.isCliWrapped) return "opencode";
  if (desc.family === "openai") return "codex";
  if (desc.family === "cursor") return "cursor";
  return "claude";
}

function runtimeFacingModelId(desc: ModelDescriptor | null | undefined, registryModelId: string): string {
  if (!desc?.isCliWrapped) return registryModelId;
  if (desc.family === "cursor" || desc.family === "openai") return desc.providerModelId || registryModelId;
  return desc.shortId ?? registryModelId;
}

function summarizeNativeControls(
  provider: AgentChatSessionSummary["provider"] | "claude" | "codex" | "opencode" | "cursor",
  controls: NativeControlState,
): Pick<
  AgentChatSessionSummary,
  "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode" | "permissionMode" | "cursorModeId"
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
  if (provider === "cursor") {
    return {
      ...(controls.cursorModeId != null ? { cursorModeId: controls.cursorModeId } : {}),
    };
  }
  return {
    opencodePermissionMode: controls.opencodePermissionMode,
    permissionMode: controls.opencodePermissionMode,
  };
}

/**
 * Build a fallback CursorModeSnapshot when the Cursor ACP provider hasn't
 * reported its own snapshot yet.
 */
function buildFallbackCursorModeSnapshot(modeId: string | null | undefined): NonNullable<AgentChatSessionSummary["cursorModeSnapshot"]> {
  const normalized = typeof modeId === "string" && modeId.trim().length ? modeId.trim() : "agent";
  return {
    currentModeId: normalized,
    availableModeIds: [...CURSOR_AVAILABLE_MODE_IDS],
  };
}

function migrateOldPrefs(): string | null {
  try {
    const oldProvider = window.localStorage.getItem(LEGACY_PROVIDER_KEY);
    const oldModel = oldProvider ? window.localStorage.getItem(`${LEGACY_MODEL_KEY_PREFIX}:${oldProvider}`) : null;
    if (oldProvider && oldModel) {
      const match = MODEL_REGISTRY.find((m) => m.shortId === oldModel || m.providerModelId === oldModel);
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
  if (model?.family === "cursor" || model?.cliCommand === "cursor") return "Cursor";
  if (model?.family === "anthropic" || model?.cliCommand === "claude") return "Claude";
  if (model?.family === "openai" || model?.cliCommand === "codex") return "Codex";
  if (sessionProvider === "claude") return "Claude";
  if (sessionProvider === "codex") return "Codex";
  if (sessionProvider === "cursor") return "Cursor";
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

function trimChatEventHistory(events: AgentChatEventEnvelope[], maxEvents: number): AgentChatEventEnvelope[] {
  return events.length > maxEvents ? events.slice(-maxEvents) : events;
}

function pruneSessionRecord<T>(record: Record<string, T>, keepIds: ReadonlySet<string>): Record<string, T> {
  let changed = false;
  const next: Record<string, T> = {};
  for (const [sessionId, value] of Object.entries(record)) {
    if (!keepIds.has(sessionId)) {
      changed = true;
      continue;
    }
    next[sessionId] = value;
  }
  return changed ? next : record;
}

function buildRetainedChatSessionIds(args: {
  rows: AgentChatSessionSummary[];
  selectedSessionId: string | null;
  lockSessionId: string | null | undefined;
  initialSessionId: string | null | undefined;
  pendingSelectedSessionId: string | null;
  optimisticSessionIds: ReadonlySet<string>;
}): Set<string> {
  const keep = new Set<string>();
  if (args.selectedSessionId) keep.add(args.selectedSessionId);
  if (args.lockSessionId) keep.add(args.lockSessionId);
  if (args.initialSessionId) keep.add(args.initialSessionId);
  if (args.pendingSelectedSessionId) keep.add(args.pendingSelectedSessionId);
  for (const sessionId of args.optimisticSessionIds) keep.add(sessionId);

  let recentAdded = 0;
  for (const row of args.rows) {
    if (keep.has(row.sessionId)) continue;
    keep.add(row.sessionId);
    recentAdded += 1;
    if (recentAdded >= MAX_RETAINED_CHAT_SESSION_HISTORIES) break;
  }

  return keep;
}

function resolveRegistryModelId(value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.id.toLowerCase() === normalized
      || model.shortId.toLowerCase() === normalized
      || model.providerModelId.toLowerCase() === normalized
  );
  return match?.id ?? null;
}

function resolveCliRegistryModelId(provider: "codex" | "claude" | "cursor", value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  if (provider === "cursor") {
    const fullId = normalized.startsWith("cursor/") ? normalized : `cursor/${normalized}`;
    const dynamic = getModelById(fullId) ?? resolveModelDescriptorForProvider(normalized.replace(/^cursor\//, ""), "cursor");
    if (dynamic && dynamic.family === "cursor" && dynamic.isCliWrapped) return dynamic.id;
    return null;
  }
  const family = provider === "codex" ? "openai" : "anthropic";
  const match = MODEL_REGISTRY.find(
    (model) =>
      model.isCliWrapped
      && model.family === family
      && (
        model.id.toLowerCase() === normalized
        || model.shortId.toLowerCase() === normalized
        || model.providerModelId.toLowerCase() === normalized
      )
  );
  return match?.id ?? null;
}

function chatToolTypeForProvider(provider: string | null | undefined): TerminalToolType {
  switch (provider) {
    case "codex": return "codex-chat";
    case "claude": return "claude-chat";
    case "cursor": return "cursor";
    default: return "opencode-chat";
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
  embeddedWorkLayout = false,
  layoutVariant = "standard",
  isTileActive = false,
  shouldAutofocusComposer = false,
  onSessionCreated,
  availableLanes,
  onLaneChange,
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
  /** Work tab draft: flatter shell, no duplicate header chrome above the composer. */
  embeddedWorkLayout?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  isTileActive?: boolean;
  shouldAutofocusComposer?: boolean;
  onSessionCreated?: (session: AgentChatSession) => void | Promise<void>;
  /** Available lanes for the lane selector in empty state */
  availableLanes?: Array<{ id: string; name: string; color?: string | null }>;
  /** Callback when lane selection changes in empty state */
  onLaneChange?: (laneId: string) => void;
}) {
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const agentTurnCompletionSound = useAppStore((s) => s.agentTurnCompletionSound);
  const agentTurnCompletionSoundVolume = useAppStore((s) => s.agentTurnCompletionSoundVolume);
  const agentTurnCompletionSoundQuietWhenFocused = useAppStore((s) => s.agentTurnCompletionSoundQuietWhenFocused);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const chatUiScale = chatFontSizePx / DEFAULT_CHAT_FONT_SIZE_PX;
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);
  const selectLane = useAppStore((s) => s.selectLane);
  const lockedSingleSessionMode = Boolean(lockSessionId && hideSessionTabs);
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
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<Set<string>>(new Set());
  const [pendingSteersBySession, setPendingSteersBySession] = useState<Record<string, PendingSteerEntry[]>>({});
  const [modelId, setModelId] = useState<string>("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [executionMode, setExecutionMode] = useState<AgentChatExecutionMode>("focused");
  const [interactionMode, setInteractionMode] = useState<AgentChatInteractionMode>(initialNativeControls.interactionMode);
  const [availableModelIds, setAvailableModelIds] = useState<string[]>([]);
  const [claudePermissionMode, setClaudePermissionMode] = useState<AgentChatClaudePermissionMode>(initialNativeControls.claudePermissionMode);
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<AgentChatCodexApprovalPolicy>(initialNativeControls.codexApprovalPolicy);
  const [codexSandbox, setCodexSandbox] = useState<AgentChatCodexSandbox>(initialNativeControls.codexSandbox);
  const [codexConfigSource, setCodexConfigSource] = useState<AgentChatCodexConfigSource>(initialNativeControls.codexConfigSource);
  const [opencodePermissionMode, setOpenCodePermissionMode] = useState<AgentChatOpenCodePermissionMode>(initialNativeControls.opencodePermissionMode);
  const prevModelDescRef = useRef<ModelDescriptor | null | undefined>(undefined);
  const [cursorModeId, setCursorModeId] = useState<string | null>(initialNativeControls.cursorModeId);
  const [cursorConfigValues, setCursorConfigValues] = useState<Record<string, AgentChatCursorConfigValue>>(initialNativeControls.cursorConfigValues);
  const [aiStatus, setAiStatus] = useState<AiStatusSnapshot | null>(null);
  const [providerConnections, setProviderConnections] = useState<{
    claude: AiProviderConnectionStatus | null;
    codex: AiProviderConnectionStatus | null;
    cursor: AiProviderConnectionStatus | null;
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
  const [closingChatSessionId, setClosingChatSessionId] = useState<string | null>(null);
  const [deletingChatSessionId, setDeletingChatSessionId] = useState<string | null>(null);
  const [computerUseSnapshot, setComputerUseSnapshot] = useState<ComputerUseOwnerSnapshot | null>(null);
  const [proofDrawerOpen, setProofDrawerOpen] = useState(false);
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(false);
  const [sessionDelta, setSessionDelta] = useState<{ insertions: number; deletions: number } | null>(null);
  const [sessionMutationKind, setSessionMutationKind] = useState<"model" | "permission" | "computer-use" | null>(null);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const [optimisticOutgoingMessage, setOptimisticOutgoingMessage] = useState<{
    sessionId: string;
    envelope: AgentChatEventEnvelope;
  } | null>(null);
  const [handoffOpen, setHandoffOpen] = useState(false);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffModelId, setHandoffModelId] = useState("");
  const shellRef = useRef<HTMLElement | null>(null);
  const composerMaxHeightPx = layoutVariant === "grid-tile" ? 144 : null;
  const sessionsRef = useRef<AgentChatSessionSummary[]>(sessions);
  const completionSoundPrevTurnActiveRef = useRef(false);
  const completionSoundArmedRef = useRef(true);

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
  const seededInitialSummaryRef = useRef(false);
  const handoffRef = useRef<HTMLDivElement | null>(null);
  const localTouchBySessionRef = useRef<Map<string, string>>(new Map());
  const cursorWarmupKeyRef = useRef<string | null>(null);
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
  const optimisticOutgoingMessageRef = useRef<typeof optimisticOutgoingMessage>(null);
  const selectedEventsForDisplay = useMemo(() => {
    if (!optimisticOutgoingMessage || optimisticOutgoingMessage.sessionId !== selectedSessionId) {
      return selectedEvents;
    }
    return [...selectedEvents, optimisticOutgoingMessage.envelope];
  }, [optimisticOutgoingMessage, selectedEvents, selectedSessionId]);
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  const selectedTurnDiffSummaries = useMemo(() => deriveTurnDiffSummaries(selectedEvents), [selectedEvents]);
  const selectedTodoItems = useMemo(() => deriveTodoItems(selectedEvents), [selectedEvents]);
  const pendingInput = selectedSessionId ? (pendingInputsBySession[selectedSessionId]?.[0] ?? null) : null;
  const selectedSessionAwaitingInput = Boolean(pendingInput) || selectedSession?.awaitingInput === true;
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;

  useEffect(() => {
    completionSoundPrevTurnActiveRef.current = false;
    completionSoundArmedRef.current = true;
  }, [selectedSessionId]);

  useEffect(() => {
    if (agentTurnCompletionSound === "off") {
      completionSoundPrevTurnActiveRef.current = turnActive;
      return;
    }
    if (turnActive) {
      completionSoundArmedRef.current = true;
    }
    const sessionEnded = selectedSession?.status === "ended";
    const settled =
      Boolean(selectedSessionId)
      && !selectedSessionAwaitingInput
      && !sessionEnded;
    const prevTurn = completionSoundPrevTurnActiveRef.current;
    const becameIdle = settled && prevTurn && !turnActive;
    completionSoundPrevTurnActiveRef.current = turnActive;
    if (becameIdle && completionSoundArmedRef.current) {
      completionSoundArmedRef.current = false;
      let lastDoneStatus: "completed" | "interrupted" | "failed" | null = null;
      for (let i = selectedEventsForDisplay.length - 1; i >= 0; i -= 1) {
        const ev = selectedEventsForDisplay[i]?.event;
        if (ev?.type === "done") {
          lastDoneStatus = ev.status;
          break;
        }
      }
      if (lastDoneStatus === "completed") {
        playAgentTurnCompletionSound(agentTurnCompletionSound, {
          volume: agentTurnCompletionSoundVolume,
          skipWhenFocused: agentTurnCompletionSoundQuietWhenFocused,
        });
      }
    }
  }, [
    agentTurnCompletionSound,
    agentTurnCompletionSoundVolume,
    agentTurnCompletionSoundQuietWhenFocused,
    selectedSessionId,
    selectedSession?.status,
    selectedSessionAwaitingInput,
    turnActive,
    selectedEventsForDisplay,
  ]);

  const activeProviderConnection = selectedSession?.provider === "claude"
    ? (providerConnections?.claude ?? null)
    : selectedSession?.provider === "codex"
      ? (providerConnections?.codex ?? null)
      : selectedSession?.provider === "cursor"
        ? (providerConnections?.cursor ?? null)
        : null;
  const pendingApprovalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of pendingInputsBySession[selectedSessionId ?? ""] ?? []) {
      ids.add(entry.itemId);
    }
    return ids;
  }, [pendingInputsBySession, selectedSessionId]);
  const pendingSteers = selectedSessionId ? (pendingSteersBySession[selectedSessionId] ?? []) : [];
  const selectedModelDesc = getModelById(modelId);
  const reasoningTiers = selectedModelDesc?.reasoningTiers ?? [];
  const localRuntimeState = useMemo(() => {
    const provider = selectedModelDesc?.authTypes.includes("local")
      ? (selectedModelDesc.family as LocalProviderFamily)
      : parseLocalProviderFromModelId(modelId);
    if (!provider) return null;
    const runtimeConnection = aiStatus?.runtimeConnections?.[provider] ?? null;
    const detectedEntry = aiStatus?.detectedAuth?.find(
      (entry): entry is { type: "local"; provider: LocalProviderFamily; endpoint: string } =>
        entry.type === "local" && entry.provider === provider,
    ) ?? null;
    const modelIds = runtimeConnection?.loadedModelIds !== undefined && runtimeConnection.loadedModelIds !== null
      ? runtimeConnection.loadedModelIds.filter((id): id is string => String(id ?? "").startsWith(`${provider}/`))
      : availableModelIds.filter((id) => id.startsWith(`${provider}/`));
    return {
      provider,
      label: LOCAL_PROVIDER_LABELS[provider],
      endpoint: runtimeConnection?.endpoint ?? detectedEntry?.endpoint ?? getLocalProviderDefaultEndpoint(provider),
      detected: Boolean(runtimeConnection?.runtimeDetected ?? detectedEntry),
      runtimeAvailable: runtimeConnection?.runtimeAvailable ?? false,
      health: runtimeConnection?.health ?? null,
      blocker: runtimeConnection?.blocker ?? null,
      modelIds,
      statusKnown: Boolean(aiStatus),
    };
  }, [aiStatus, availableModelIds, modelId, selectedModelDesc]);
  const localRuntimeNotice = useMemo(() => {
    if (!localRuntimeState) return null;
    if (!localRuntimeState.statusKnown) {
      return {
        tone: "warning" as const,
        title: `${localRuntimeState.label} runtime`,
        message: `ADE could not read ${localRuntimeState.label} status right now. It will still try the OpenCode runtime path, but refresh settings if the runtime changed.`,
      };
    }
    if (localRuntimeState.blocker) {
      return {
        tone: "warning" as const,
        title: `${localRuntimeState.label} runtime`,
        message: localRuntimeState.blocker,
      };
    }
    if (!localRuntimeState.detected) {
      return {
        tone: "warning" as const,
        title: `${localRuntimeState.label} runtime`,
        message: `${localRuntimeState.label} is not detected at ${localRuntimeState.endpoint}. Start it, load a model, then refresh so ADE can use the local runtime.`,
      };
    }
    if (!localRuntimeState.modelIds.length) {
      return {
        tone: "warning" as const,
        title: `${localRuntimeState.label} runtime`,
        message: `${localRuntimeState.label} responded, but no loaded models were reported yet. Load a model in ${localRuntimeState.label} and refresh.`,
      };
    }
    // Check if the selected model matches any loaded model, accounting for
    // OpenCode registry IDs (opencode/lmstudio/X) vs local IDs (lmstudio/X).
    const decoded = decodeOpenCodeRegistryId(modelId);
    const localModelId = decoded ? `${decoded.openCodeProviderId}/${decoded.openCodeModelId}` : modelId;
    if (!localRuntimeState.modelIds.includes(modelId) && !localRuntimeState.modelIds.includes(localModelId)) {
      return {
        tone: "warning" as const,
        title: `${localRuntimeState.label} runtime`,
        message: `${localRuntimeState.label} is running, but ${selectedModelDesc?.displayName ?? formatLocalModelLabel(modelId)} is not in the loaded model list. Choose one of the loaded models or load this model in ${localRuntimeState.label}.`,
      };
    }
    return {
      tone: "success" as const,
      title: `${localRuntimeState.label} runtime`,
      message: `${localRuntimeState.label} is connected with ${localRuntimeState.modelIds.length} loaded model${localRuntimeState.modelIds.length === 1 ? "" : "s"}${localRuntimeState.health ? ` (${localRuntimeState.health})` : ""}.`,
    };
  }, [localRuntimeState, modelId, selectedModelDesc?.displayName]);

  const cliRuntimeBlocked = Boolean(
    selectedSessionId
    && activeProviderConnection
    && !activeProviderConnection.runtimeAvailable
    && (activeProviderConnection.blocker || activeProviderConnection.provider === "cursor"),
  );
  const cliRuntimeTitle = activeProviderConnection?.provider === "claude"
    ? "Claude runtime"
    : activeProviderConnection?.provider === "cursor"
      ? "Cursor runtime"
      : "Codex runtime";
  const cliRuntimeBody = activeProviderConnection?.blocker
    ?? (activeProviderConnection?.provider === "cursor"
      ? "Cursor agent is not available. Ensure Cursor is installed and the agent is enabled."
      : null);

  const mergedRuntimeBanner = useMemo(() => {
    if (!cliRuntimeBlocked && !localRuntimeNotice) return null;
    if (cliRuntimeBlocked && localRuntimeNotice) {
      return {
        kind: "merged" as const,
        cliTitle: cliRuntimeTitle,
        cliBody: cliRuntimeBody ?? "",
        localNotice: localRuntimeNotice,
        localEndpoint: localRuntimeState?.endpoint,
      };
    }
    if (cliRuntimeBlocked) {
      return {
        kind: "cli-only" as const,
        cliTitle: cliRuntimeTitle,
        cliBody: cliRuntimeBody ?? "",
      };
    }
    return {
      kind: "local-only" as const,
      localNotice: localRuntimeNotice!,
      localEndpoint: localRuntimeState?.endpoint,
    };
  }, [
    cliRuntimeBlocked,
    cliRuntimeBody,
    cliRuntimeTitle,
    localRuntimeNotice,
    localRuntimeState?.endpoint,
  ]);

  useEffect(() => {
    prevModelDescRef.current = getModelDescriptorForPermissionMode(modelId);
  }, [modelId]);

  const surfaceMode = presentation?.mode ?? "standard";
  const identitySessionSettingsBusy = isPersistentIdentitySurface && sessionMutationKind !== null;

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  const modelSelectionDiffersFromSession = Boolean(selectedSession && selectedSessionModelId && selectedSessionModelId !== modelId);

  const sessionProvider = useMemo(() => {
    if (selectedSession && !modelSelectionDiffersFromSession) return selectedSession.provider;
    return resolveChatRuntimeProvider(getModelById(modelId));
  }, [selectedSession, modelSelectionDiffersFromSession, modelId]);
  const effectiveCursorModeSnapshot = useMemo(() => {
    if (sessionProvider !== "cursor") return null;
    const base = selectedSession?.cursorModeSnapshot ?? buildFallbackCursorModeSnapshot(cursorModeId);
    return {
      ...base,
      currentModeId: cursorModeId ?? base.currentModeId,
      configOptions: base.configOptions?.map((option) => {
        if (option.id === base.modeConfigId) {
          return { ...option, currentValue: cursorModeId ?? option.currentValue };
        }
        if (Object.prototype.hasOwnProperty.call(cursorConfigValues, option.id)) {
          return { ...option, currentValue: cursorConfigValues[option.id] ?? option.currentValue };
        }
        return option;
      }),
    };
  }, [cursorConfigValues, cursorModeId, selectedSession?.cursorModeSnapshot, sessionProvider]);

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) {
      setInteractionMode(initialNativeControls.interactionMode);
      setClaudePermissionMode(initialNativeControls.claudePermissionMode);
      setCodexApprovalPolicy(initialNativeControls.codexApprovalPolicy);
      setCodexSandbox(initialNativeControls.codexSandbox);
      setCodexConfigSource(initialNativeControls.codexConfigSource);
      setOpenCodePermissionMode(initialNativeControls.opencodePermissionMode);
      setCursorModeId(initialNativeControls.cursorModeId);
      setCursorConfigValues(initialNativeControls.cursorConfigValues);
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
    setOpenCodePermissionMode(session.opencodePermissionMode ?? initialNativeControls.opencodePermissionMode);
    setCursorModeId(session.cursorModeId ?? session.cursorModeSnapshot?.currentModeId ?? initialNativeControls.cursorModeId);
    setCursorConfigValues(
      Object.fromEntries(
        (session.cursorModeSnapshot?.configOptions ?? [])
          .filter((option) => option.id !== session.cursorModeSnapshot?.modeConfigId)
          .flatMap((option) => option.currentValue == null ? [] : [[option.id, option.currentValue]]),
      ),
    );
  }, [initialNativeControls]);
  const executionModeOptions = useMemo(
    () => getExecutionModeOptions(selectedModelDesc),
    [selectedModelDesc],
  );
  const selectedExecutionMode = useMemo(
    () => executionModeOptions.find((option) => option.value === executionMode) ?? executionModeOptions[0] ?? null,
    [executionMode, executionModeOptions],
  );
  const hasComputerUseSelectionChanged = false;
  const launchModeEditable = !selectedSessionId || selectedEvents.length === 0;
  const resolvedTitle = presentation?.title?.trim()
    || (surfaceMode === "resolver" ? "AI Resolver" : selectedSession ? chatSessionTitle(selectedSession) : "New chat");
  const assistantLabel = presentation?.assistantLabel?.trim()
    || resolveAssistantLabel(selectedModelDesc, selectedSession?.provider);
  const messagePlaceholder = presentation?.messagePlaceholder?.trim() || "Type to vibecode...";
  const chipsJson = JSON.stringify(presentation?.chips ?? []);
  const resolvedChips = useMemo(() => JSON.parse(chipsJson) as ChatSurfaceChip[], [chipsJson]);

  // Keep all configured models selectable, and always include the active session model.
  // All models are available regardless of surface — the runtime handles provider transitions.
  const effectiveAvailableModelIds = useMemo(() => {
    return filterChatModelIdsForSession({
      availableModelIds,
      activeSessionModelId: selectedSessionModelId,
      hasConversation: selectedEvents.length > 0,
      policy: modelSwitchPolicy,
    });
  }, [availableModelIds, modelSwitchPolicy, selectedSessionModelId, selectedEvents.length]);
  const handoffAvailableModelIds = useMemo(() => {
    const merged = new Set<string>(availableModelIds);
    if (selectedSessionModelId) {
      merged.add(selectedSessionModelId);
    }
    const ordered = MODEL_REGISTRY
      .filter((model) => !model.deprecated && merged.has(model.id))
      .map((model) => model.id);
    const extras = [...merged].filter((modelId) => !ordered.includes(modelId));
    extras.sort((left, right) => {
      const leftLabel = getModelById(left)?.displayName ?? left;
      const rightLabel = getModelById(right)?.displayName ?? right;
      return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
    });
    return [...ordered, ...extras];
  }, [availableModelIds, selectedSessionModelId]);
  const canShowHandoff = Boolean(
    lockSessionId
      && selectedSessionId
      && selectedSession
      && handoffAvailableModelIds.length > 0
      && surfaceMode === "standard"
      && !isPersistentIdentitySurface
      && (selectedSession.surface ?? "work") === "work",
  );
  const handoffBlocked = turnActive || selectedSessionAwaitingInput || handoffBusy;
  const handoffButtonTitle = handoffBlocked
    ? "Wait for the current output or approval to finish before handing off this chat."
    : "Create a new work chat on another model and seed it with a summary of this chat.";
  const showClaudeCacheTimer = shouldShowClaudeCacheTtl({
    provider: selectedSession?.provider ?? null,
    status: selectedSession?.status ?? null,
    idleSinceAt: selectedSession?.idleSinceAt,
    awaitingInput: selectedSessionAwaitingInput,
  });

  const refreshAvailableModels = useCallback(async () => {
    const shouldRefreshOpenCodeInventory = sessionProvider === "opencode";
    try {
      const status = await getAiStatusCached({
        projectRoot,
        ...(shouldRefreshOpenCodeInventory ? { refreshOpenCodeInventory: true } : {}),
      });
      setAiStatus(status);
      setProviderConnections({
        claude: status.providerConnections?.claude ?? null,
        codex: status.providerConnections?.codex ?? null,
        cursor: status.providerConnections?.cursor ?? null,
      });
      const available = deriveConfiguredModelIds(status);
      setAvailableModelIds(available);
      return available;
    } catch {
      setAiStatus(null);
      setProviderConnections(null);
      // Fall back to direct model discovery probes below.
    }

    try {
      const [codexModels, claudeModels, cursorModels, openCodeModels] = await Promise.all([
        getAgentChatModelsCached({ projectRoot, provider: "codex" }).catch(() => []),
        getAgentChatModelsCached({ projectRoot, provider: "claude" }).catch(() => []),
        getAgentChatModelsCached({ projectRoot, provider: "cursor" }).catch(() => []),
        getAgentChatModelsCached({
          projectRoot,
          provider: "opencode",
          activateRuntime: shouldRefreshOpenCodeInventory,
        }).catch(() => []),
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
      for (const model of cursorModels) {
        const resolved = resolveCliRegistryModelId("cursor", model.id);
        if (resolved) available.add(resolved);
      }
      for (const model of openCodeModels) {
        const resolved = resolveRegistryModelId(model.id);
        if (resolved) {
          available.add(resolved);
        } else {
          available.add(model.id);
        }
      }

      const ordered = MODEL_REGISTRY
        .filter((model) => !model.deprecated && available.has(model.id))
        .map((model) => model.id);
      const extra = [...available].filter((modelId) => !ordered.includes(modelId));
      extra.sort((left, right) => {
        const leftLabel = getModelById(left)?.displayName ?? left;
        const rightLabel = getModelById(right)?.displayName ?? right;
        return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
      });
      const allAvailable = [...ordered, ...extra];
      setAvailableModelIds(allAvailable);
      return allAvailable;
    } catch {
      setAvailableModelIds([]);
      return [];
    }
  }, [projectRoot, sessionProvider]);

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

  const refreshLockedSessionSummary = useCallback(async () => {
    if (!lockSessionId) {
      setSessions([]);
      return null;
    }

    let summary: AgentChatSessionSummary | null;
    if (!seededInitialSummaryRef.current && initialSessionSummary?.sessionId === lockSessionId) {
      summary = initialSessionSummary;
      seededInitialSummaryRef.current = true;
    } else {
      summary = await window.ade.agentChat.getSummary({ sessionId: lockSessionId });
    }

    setSessions(summary ? [summary] : []);
    setTurnActiveBySession((prev) => {
      const nextRunning = Boolean(summary && summary.status === "active" && summary.awaitingInput !== true);
      return prev[lockSessionId] === nextRunning
        ? prev
        : { ...prev, [lockSessionId]: nextRunning };
    });
    draftSelectionLockedRef.current = false;
    setSelectedSessionId(lockSessionId);
    return summary;
  }, [initialSessionSummary, lockSessionId]);

  const refreshSessions = useCallback(async () => {
    if (lockedSingleSessionMode && lockSessionId) {
      await refreshLockedSessionSummary();
      return;
    }
    if (!laneId) {
      setSessions([]);
      eventsBySessionRef.current = {};
      loadedHistoryRef.current.clear();
      setEventsBySession({});
      setTurnActiveBySession({});
      setPendingInputsBySession({});
      setPendingSteersBySession({});
      return;
    }

    const rows = await window.ade.agentChat.list({ laneId });
    const nextRows = sortSessionSummariesByRecency(rows, localTouchBySessionRef.current);
    setSessions(nextRows);
    const retainedSessionIds = buildRetainedChatSessionIds({
      rows: nextRows,
      selectedSessionId: selectedSessionIdRef.current,
      lockSessionId,
      initialSessionId,
      pendingSelectedSessionId: pendingSelectedSessionIdRef.current,
      optimisticSessionIds: optimisticSessionIdsRef.current,
    });
    eventsBySessionRef.current = pruneSessionRecord(eventsBySessionRef.current, retainedSessionIds);
    for (const sessionId of [...loadedHistoryRef.current]) {
      if (!retainedSessionIds.has(sessionId)) {
        loadedHistoryRef.current.delete(sessionId);
      }
    }
    setEventsBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    setTurnActiveBySession((prev) => {
      const base = pruneSessionRecord(prev, retainedSessionIds);
      let next: Record<string, boolean> | null = base === prev ? null : base;
      for (const row of nextRows) {
        const shouldAppearRunning = row.status === "active" && row.awaitingInput !== true;
        const source = next ?? base;
        if ((source[row.sessionId] ?? false) && !shouldAppearRunning) {
          next ??= { ...source };
          next[row.sessionId] = false;
        }
      }
      return next ?? base;
    });
    setPendingInputsBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    setPendingSteersBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
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
  }, [forceDraft, initialSessionId, laneId, lockSessionId, lockedSingleSessionMode, preferDraftStart, refreshLockedSessionSummary]);

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
    void refreshAvailableModels();
  }, [refreshAvailableModels, selectedSession?.provider]);

  useEffect(() => {
    if (!turnActive || !selectedSession?.provider) return;
    const timer = window.setInterval(() => {
      void refreshAvailableModels();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAvailableModels, selectedSession?.provider, turnActive]);

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

  const loadHistory = useCallback(async (sessionId: string, options?: { force?: boolean }) => {
    if (options?.force) {
      loadedHistoryRef.current.delete(sessionId);
    }
    if (loadedHistoryRef.current.has(sessionId)) return;
    loadedHistoryRef.current.add(sessionId);

    try {
      const summary = await window.ade.sessions.get(sessionId);
      if (!summary || !isChatToolType(summary.toolType)) return;
      const raw = await window.ade.sessions.readTranscriptTail({
        sessionId,
        maxBytes: CHAT_HISTORY_READ_MAX_BYTES,
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
        // Prefer the monotonic event sequence when available because multiple
        // events can share the same millisecond timestamp during streaming.
        const lastParsed = parsed[parsed.length - 1]!;
        const lastParsedSequence = typeof lastParsed.sequence === "number" ? lastParsed.sequence : null;
        const lastParsedTs = lastParsed.timestamp;
        const tail = existing.filter((entry) => {
          if (lastParsedSequence != null && typeof entry.sequence === "number") {
            return entry.sequence > lastParsedSequence;
          }
          return entry.timestamp > lastParsedTs;
        });
        merged = tail.length ? [...parsed, ...tail] : parsed;
      } else if (existing.length) {
        // No transcript on disk — keep the real-time events as-is.
        merged = existing;
      } else {
        merged = parsed;
      }
      merged = trimChatEventHistory(
        merged,
        sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
          ? MAX_SELECTED_CHAT_SESSION_EVENTS
          : MAX_BACKGROUND_CHAT_SESSION_EVENTS,
      );

      const derived = deriveRuntimeState(merged);
      const sessionSummary = sessionsRef.current.find((entry) => entry.sessionId === sessionId)
        ?? (initialSessionSummary?.sessionId === sessionId ? initialSessionSummary : null);
      const allowRunningFromSummary = sessionSummary?.status === "active" && sessionSummary.awaitingInput !== true;
      eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: merged };
      setEventsBySession((prev) => ({ ...prev, [sessionId]: merged }));
      setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: allowRunningFromSummary ? derived.turnActive : false }));
      setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: derived.pendingInputs }));
      setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: derived.pendingSteers }));
    } catch {
      // Ignore transcript history failures.
    }
  }, [initialSessionSummary, lockSessionId]);

  const clearSessionView = useCallback((sessionId: string) => {
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: [] };
    setEventsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: [] }));
  }, []);

  useEffect(() => {
    if (lockSessionId) {
      pendingSelectedSessionIdRef.current = null;
      draftSelectionLockedRef.current = false;
      setSelectedSessionId(lockSessionId);
    }
  }, [lockSessionId]);

  useEffect(() => {
    if (!lockedSingleSessionMode || !lockSessionId || initialSessionSummary?.sessionId !== lockSessionId) return;
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
    eagerCreateFiredRef.current = false;
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
  }, [
    selectedSession?.sessionId,
    selectedSessionModelId,
    selectedSession?.interactionMode,
    selectedSession?.claudePermissionMode,
    selectedSession?.codexApprovalPolicy,
    selectedSession?.codexSandbox,
    selectedSession?.codexConfigSource,
    selectedSession?.opencodePermissionMode,
    selectedSession?.permissionMode,
    selectedSession?.cursorModeId,
    selectedSession?.cursorModeSnapshot?.currentModeId,
    selectedSession?.cursorModeSnapshot?.configOptions,
    syncComposerToSession,
  ]);

  useEffect(() => {
    if (!selectedSessionId || !selectedSessionModelId || turnActive) return;
    const desc = getModelById(selectedSessionModelId);
    if (!desc?.isCliWrapped || desc.family !== "cursor") return;
    const warmupKey = `${selectedSessionId}:${selectedSessionModelId}:${selectedSession?.cursorModeSnapshot?.currentModeId ?? cursorModeId ?? "agent"}`;
    if (cursorWarmupKeyRef.current === warmupKey) return;
    cursorWarmupKeyRef.current = warmupKey;
    window.ade.agentChat.warmupModel({
      sessionId: selectedSessionId,
      modelId: selectedSessionModelId,
    }).then(() => refreshSessions()).catch(() => {});
  }, [
    cursorModeId,
    refreshSessions,
    selectedSession?.cursorModeSnapshot?.currentModeId,
    selectedSessionId,
    selectedSessionModelId,
    turnActive,
  ]);

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
        await Promise.all([refreshAvailableModels(), refreshSessions()]);
      } catch {
        // boot-time refresh errors are swallowed here; individual callbacks fall back to empty state
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
  }, [refreshAvailableModels, refreshSessions]);

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
      // Re-read the selected transcript on every tab switch so the selected
      // chat can recover from any background event loss instead of relying
      // solely on the in-memory background buffer.
      void loadHistory(selectedSessionId, { force: true });
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
    setOptimisticOutgoingMessage(null);
  }, [selectedSessionId]);

  useEffect(() => {
    optimisticOutgoingMessageRef.current = optimisticOutgoingMessage;
  }, [optimisticOutgoingMessage]);

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
      const updated = trimChatEventHistory(
        [...sessionEvents, envelope],
        sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
          ? MAX_SELECTED_CHAT_SESSION_EVENTS
          : MAX_BACKGROUND_CHAT_SESSION_EVENTS,
      );
      if (next === eventsBySessionRef.current) {
        next = { ...eventsBySessionRef.current };
      }
      next[sessionId] = updated;
      touchedSessionIds.add(sessionId);
    }

    if (!touchedSessionIds.size) return;

    // Commit the ref immediately so subsequent flushes see the latest events.
    eventsBySessionRef.current = next;

    // Derive turnActive, approvals, and pending steers from the fully-updated event lists.
    const activePatch: Record<string, boolean> = {};
    const pendingInputPatch: Record<string, DerivedPendingInput[]> = {};
    const pendingSteerPatch: Record<string, PendingSteerEntry[]> = {};
    for (const sessionId of touchedSessionIds) {
      const derived = deriveRuntimeState(next[sessionId] ?? []);
      activePatch[sessionId] = derived.turnActive;
      pendingInputPatch[sessionId] = derived.pendingInputs;
      pendingSteerPatch[sessionId] = derived.pendingSteers;
    }

    // All setters fire synchronously — React 18 batches them into one render.
    setEventsBySession(next);
    setTurnActiveBySession((activePrev) => ({ ...activePrev, ...activePatch }));
    setPendingInputsBySession((pendingPrev) => ({ ...pendingPrev, ...pendingInputPatch }));
    setPendingSteersBySession((steerPrev) => ({ ...steerPrev, ...pendingSteerPatch }));
  }, [lockSessionId]);

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

  const patchSessionSummary = useCallback((sessionId: string, patch: Partial<AgentChatSessionSummary>) => {
    setSessions((prev) => {
      const next = prev.map((session) => (
        session.sessionId === sessionId ? { ...session, ...patch } : session
      ));
      return sortSessionSummariesByRecency(next, localTouchBySessionRef.current);
    });
  }, []);

  useEffect(() => {
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      if (
        optimisticOutgoingMessageRef.current?.sessionId === envelope.sessionId
        && envelope.event.type === "user_message"
      ) {
        setOptimisticOutgoingMessage(null);
      }
      const acceptsEvent =
        knownSessionIdsRef.current.has(envelope.sessionId)
        || optimisticSessionIdsRef.current.has(envelope.sessionId)
        || pendingSelectedSessionIdRef.current === envelope.sessionId;
      if (!acceptsEvent) return;
      pendingEventQueueRef.current.push(envelope);
      const touchTimestamp = getChatSessionLocalTouchTimestampForEvent(envelope);
      if (touchTimestamp) {
        touchSession(envelope.sessionId, touchTimestamp);
      }
      if (
        envelope.event.type === "user_message"
        || (envelope.event.type === "status" && envelope.event.turnStatus === "started")
      ) {
        patchSessionSummary(envelope.sessionId, {
          status: "active",
          idleSinceAt: null,
          awaitingInput: false,
          lastActivityAt: envelope.timestamp,
        });
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

      // Refresh sessions when permission mode changes so the UI permission
      // picker stays in sync (e.g. when Claude enters/exits plan mode).
      if (
        envelope.event.type === "system_notice"
        && envelope.event.noticeKind === "info"
      ) {
        const detail = envelope.event.detail && typeof envelope.event.detail === "object"
          ? envelope.event.detail as Record<string, unknown>
          : null;
        const transition = typeof detail?.permissionModeTransition === "string"
          ? detail.permissionModeTransition
          : null;
        if (transition === "entered_plan_mode" || transition === "exited_plan_mode") {
          scheduleSessionsRefresh();
        }
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
  }, [lockSessionId, flushQueuedEvents, patchSessionSummary, scheduleQueuedEventFlush, scheduleSessionsRefresh, touchSession]);

  useEffect(() => {
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      if (!selectedSessionId) return;
      if (event.owner?.kind === "chat_session" && event.owner.id === selectedSessionId) {
        void refreshComputerUseSnapshot(selectedSessionId, { force: true });
      }
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

  const currentNativeControls = useMemo<NativeControlState>(() => ({
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    opencodePermissionMode,
    cursorModeId,
    cursorConfigValues,
  }), [
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    opencodePermissionMode,
    cursorModeId,
    cursorConfigValues,
  ]);
  const nativeControlsRef = useRef<NativeControlState>(currentNativeControls);
  useEffect(() => {
    nativeControlsRef.current = currentNativeControls;
  }, [currentNativeControls]);

  const buildNativeControlPayload = useCallback((provider: ChatRuntimeProviderKey) => {
    return {
      ...summarizeNativeControls(provider, currentNativeControls),
      ...(provider === "cursor" ? { cursorConfigValues: currentNativeControls.cursorConfigValues } : {}),
    };
  }, [currentNativeControls]);
  const buildModelSelectionSnapshot = useCallback((nextModelId: string) => {
    const previousDesc = prevModelDescRef.current;
    const nextDesc = getModelById(nextModelId);
    const nextPermissionDesc = getModelDescriptorForPermissionMode(nextModelId);
    const nextProvider = resolveChatRuntimeProvider(nextDesc);
    const nextModel = nextProvider === "opencode" ? nextModelId : runtimeFacingModelId(nextDesc, nextModelId);
    const tiers = nextDesc?.reasoningTiers ?? [];
    const preferred = readLastUsedReasoningEffort({ laneId, modelId: nextModelId });
    const nextReasoningEffort = selectReasoningEffort({ tiers, preferred });
    const nextRec = recommendedOpenCodePermissionModeForModel(nextPermissionDesc);
    return {
      nextDesc,
      nextModelId,
      nextModel,
      nextProvider,
      nextReasoningEffort,
      nextOpenCodePermissionMode: nextRec,
      resetOpenCodePermissionToDefault: shouldResetOpenCodePermissionForModelSwitch(previousDesc, nextPermissionDesc),
    };
  }, [laneId]);
  const applyModelSelectionSnapshot = useCallback((snapshot: {
    nextModelId: string;
    nextReasoningEffort: string | null;
    nextOpenCodePermissionMode?: AgentChatOpenCodePermissionMode | null;
    resetOpenCodePermissionToDefault?: boolean;
  }) => {
    setModelId(snapshot.nextModelId);
    setReasoningEffort(snapshot.nextReasoningEffort);
    const nextOpenCodeMode = snapshot.nextOpenCodePermissionMode ?? null;
    const targetOpenCodeMode = snapshot.resetOpenCodePermissionToDefault
      ? (nextOpenCodeMode ?? initialNativeControls.opencodePermissionMode)
      : nextOpenCodeMode;
    if (targetOpenCodeMode != null) {
      setOpenCodePermissionMode(targetOpenCodeMode);
    }
  }, [initialNativeControls.opencodePermissionMode]);
  const notifySessionCreated = useCallback((session: AgentChatSession) => {
    if (!onSessionCreated) return;
    void Promise.resolve(onSessionCreated(session)).catch((err) => { console.error("notifySessionCreated failed:", err); });
  }, [onSessionCreated]);

  const createSession = useCallback(async (): Promise<string | null> => {
    if (createSessionPromiseRef.current) {
      return createSessionPromiseRef.current;
    }
    if (!laneId) return null;
    const createPromise = (async () => {
      const desc = getModelById(modelId);
      const permissionDesc = getModelDescriptorForPermissionMode(modelId);
      const provider = resolveChatRuntimeProvider(desc);
      const model = provider === "opencode" ? modelId : runtimeFacingModelId(desc, modelId);
      const sessionProfile = resolveChatSessionProfile();
      const harnessPermissionMode = provider === "opencode"
        ? recommendedOpenCodePermissionModeForModel(permissionDesc)
        : null;
      const nativeControlPayload = harnessPermissionMode
        ? {
            ...summarizeNativeControls(provider, {
              ...currentNativeControls,
              opencodePermissionMode: harnessPermissionMode,
            }),
            ...(provider === "cursor" ? { cursorConfigValues: currentNativeControls.cursorConfigValues } : {}),
          }
        : buildNativeControlPayload(provider);
      const created = await window.ade.agentChat.create({
        laneId,
        provider,
        model,
        modelId,
        sessionProfile,
        reasoningEffort,
        ...nativeControlPayload,
      });
      loadedHistoryRef.current.delete(created.id);
      optimisticSessionIdsRef.current.add(created.id);
      knownSessionIdsRef.current.add(created.id);
      pendingSelectedSessionIdRef.current = created.id;
      draftSelectionLockedRef.current = false;
      touchSession(created.id);
      setSelectedSessionId(created.id);
      if (desc?.isCliWrapped && (desc.family === "anthropic" || desc.family === "cursor")) {
        window.ade.agentChat.warmupModel({
          sessionId: created.id,
          modelId,
        }).then(() => refreshSessions()).catch(() => { /* warmup is best-effort */ });
      }
      notifySessionCreated(created);
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
  }, [buildNativeControlPayload, currentNativeControls, laneId, modelId, notifySessionCreated, reasoningEffort, refreshSessions, touchSession]);

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
      notifySessionCreated(result.session);
      void refreshSessions().catch(() => {});
    } catch (handoffError) {
      setError(handoffError instanceof Error ? handoffError.message : String(handoffError));
    } finally {
      setHandoffBusy(false);
    }
  }, [canShowHandoff, handoffBlocked, handoffModelId, notifySessionCreated, refreshSessions, selectedSessionId]);

  const handleEndSelectedChat = useCallback(() => {
    if (!selectedSessionId || !selectedSession || selectedSession.status === "ended") return;
    setError(null);
    setClosingChatSessionId(selectedSessionId);
    void window.ade.agentChat.dispose({ sessionId: selectedSessionId })
      .then(async () => {
        invalidateSessionListCache();
        await refreshSessions().catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`End chat failed: ${message}`);
      })
      .finally(() => {
        setClosingChatSessionId((current) => (current === selectedSessionId ? null : current));
      });
  }, [refreshSessions, selectedSession, selectedSessionId]);

  const handleDeleteSelectedChat = useCallback(() => {
    if (!selectedSessionId || !selectedSession || selectedSession.status !== "ended") return;
    const label = chatSessionTitle(selectedSession).trim() || "this chat";
    const confirmed = window.confirm(
      `Delete "${label}"?\n\nThis permanently removes the saved chat history from ADE.`,
    );
    if (!confirmed) return;

    setError(null);
    setDeletingChatSessionId(selectedSessionId);
    void window.ade.agentChat.delete({ sessionId: selectedSessionId })
      .then(async () => {
        invalidateSessionListCache();
        draftsPerSessionRef.current.delete(selectedSessionId);
        localTouchBySessionRef.current.delete(selectedSessionId);
        loadedHistoryRef.current.delete(selectedSessionId);
        await refreshSessions().catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Delete failed: ${message}`);
      })
      .finally(() => {
        setDeletingChatSessionId((current) => (current === selectedSessionId ? null : current));
      });
  }, [refreshSessions, selectedSession, selectedSessionId]);

  // ── Eager session creation ──
  // Create a session as soon as we have a model + lane, so slash commands
  // and other pre-chat metadata are available immediately.
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
    const isLiteralSlashCommand = isProviderSlashCommandInput(text);

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
      const shouldPromoteLightSession = shouldPromoteSessionForComputerUse(selectedSession);
      const selectedModelChanged =
        Boolean(selectedSessionId)
        && Boolean(selectedSessionModelId)
        && selectedSessionModelId !== modelId;
      const selectedAttachments = isLiteralSlashCommand ? [] : attachmentsSnapshot;
      const optimisticEnvelope = (nextSessionId: string): AgentChatEventEnvelope => ({
        sessionId: nextSessionId,
        timestamp: new Date().toISOString(),
        event: {
          type: "user_message",
          text: finalText,
          ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
          deliveryState: "queued",
        },
      });

      if (sessionId && !turnActive && (selectedModelChanged || hasComputerUseSelectionChanged || shouldPromoteLightSession)) {
        setOptimisticOutgoingMessage({ sessionId, envelope: optimisticEnvelope(sessionId) });
        const desc = getModelById(modelId);
        const provider = resolveChatRuntimeProvider(desc);
        await window.ade.agentChat.updateSession({
          sessionId,
          modelId,
          reasoningEffort,
          ...buildNativeControlPayload(provider),
        });
        void refreshSessions().catch(() => {});
      } else if (!sessionId) {
        // No session yet — create one
        sessionId = await createSession();
        if (!sessionId) {
          throw new Error("Unable to create chat session.");
        }
        justCreatedSession = true;
        setOptimisticOutgoingMessage({ sessionId, envelope: optimisticEnvelope(sessionId) });
      }
      if (!sessionId) {
        throw new Error("Unable to create chat session.");
      }

      touchSession(sessionId);
      patchSessionSummary(sessionId, {
        status: "active",
        idleSinceAt: null,
        awaitingInput: false,
        lastActivityAt: new Date().toISOString(),
      });

      const steerSupportsAttachments = sessionProvider === "claude" || sessionProvider === "codex";
      const steerAttachments = steerSupportsAttachments ? selectedAttachments : [];
      const steerText = selectedAttachments.length && !steerSupportsAttachments
        ? `${finalText}\n\nAttached context:\n${selectedAttachments.map((entry) => `- ${entry.type}: ${entry.path}`).join("\n")}`
        : finalText;
      if (turnActiveBySession[sessionId]) {
        setOptimisticOutgoingMessage(null);
        await window.ade.agentChat.steer({
          sessionId,
          text: steerText,
          ...(steerAttachments.length ? { attachments: steerAttachments } : {}),
        });
      } else {
        try {
          setOptimisticOutgoingMessage({ sessionId, envelope: optimisticEnvelope(sessionId) });
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
            await window.ade.agentChat.steer({
              sessionId,
              text: steerText,
              ...(steerAttachments.length ? { attachments: steerAttachments } : {}),
            });
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
      setOptimisticOutgoingMessage(null);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setDraft((current) => (current.trim().length ? current : draftSnapshot));
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setOptimisticOutgoingMessage(null);
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
    draft,
    executionMode,
    hasComputerUseSelectionChanged,
    includeProjectDocs,
    interactionMode,
    laneId,
    launchModeEditable,
    modelId,
    reasoningEffort,
    refreshAvailableModels,
    refreshSessions,
    selectedSessionId,
    selectedSessionModelId,
    sessionProvider,
    touchSession,
    turnActive,
    turnActiveBySession
  ]);

  const interrupt = useCallback(async () => {
    if (!selectedSessionId) return;
    // Let the stop button disappear immediately while the main-process interrupt finishes.
    setTurnActiveBySession((prev) => ({ ...prev, [selectedSessionId]: false }));
    try {
      touchSession(selectedSessionId);
      await window.ade.agentChat.interrupt({ sessionId: selectedSessionId });
    } catch (interruptError) {
      setError(interruptError instanceof Error ? interruptError.message : String(interruptError));
    }
  }, [selectedSessionId, touchSession]);

  const handleApproval = useCallback(async (
    itemId: string,
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => {
    if (!selectedSessionId) return;
    try {
      touchSession(selectedSessionId);
      setRespondingApprovalIds((prev) => new Set(prev).add(itemId));
      await window.ade.agentChat.respondToInput({
        sessionId: selectedSessionId,
        itemId,
        decision,
        responseText,
        ...(answers ? { answers } : {}),
      });
      setPendingInputsBySession((prev) => ({
        ...prev,
        [selectedSessionId]: (prev[selectedSessionId] ?? []).filter((entry) => entry.itemId !== itemId)
      }));
      setRespondingApprovalIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
      await refreshSessions().catch(() => {});
    } catch (approvalError) {
      setRespondingApprovalIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
    }
  }, [refreshSessions, selectedSessionId, touchSession]);

  const approve = useCallback(async (
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => {
    if (!selectedSessionId) return;
    const request = pendingInputsBySession[selectedSessionId]?.[0];
    if (!request) return;
    await handleApproval(request.itemId, decision, responseText, answers);
  }, [handleApproval, pendingInputsBySession, selectedSessionId]);

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
    setOpenCodePermissionMode(nextControls.opencodePermissionMode);
    setCursorModeId(nextControls.cursorModeId);
    setCursorConfigValues(nextControls.cursorConfigValues);

    if (!selectedSessionId) return;

    const provider = selectedSession?.provider ?? sessionProvider;
    const nextSummary = {
      ...summarizeNativeControls(provider, nextControls),
      ...(provider === "cursor" ? { cursorConfigValues: nextControls.cursorConfigValues } : {}),
    };
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

  const handleComputerUsePolicyChange = useCallback(async (_nextPolicy: unknown) => {
    // Computer-use policy gating has been removed; this handler is a no-op retained for UI compat.
  }, []);

  if (!laneId) {
    return (
      <ChatSurfaceShell mode={surfaceMode} accentColor={presentation?.accentColor} contentScale={chatUiScale}>
        <div className="flex h-full items-center justify-center">
          <span className="font-sans text-[12px] text-muted-fg/30">Select a lane to start chatting</span>
        </div>
      </ChatSurfaceShell>
    );
  }
  // Provider-derived accent first so Claude is always amber, Codex always
  // warm-white, etc. — keeps chat surfaces consistent across model variants
  // and across desktop/mobile. Falls back to the per-model registry color
  // when the provider isn't in the unified table.
  const draftAccent =
    providerChatAccent(selectedSession?.provider ?? selectedModelDesc?.family ?? null)
    ?? selectedModelDesc?.color
    ?? "#A1A1AA";
  const proofSessionId = selectedSessionId ?? "";
  const proofPanelContent = (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="font-sans text-[12px] font-medium text-fg/80">Artifacts</span>
        <button
          type="button"
          className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/50 transition-colors hover:text-fg/80"
          onClick={() => setProofDrawerOpen(false)}
          title="Close artifacts panel"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <ChatComputerUsePanel
          sessionId={proofSessionId}
          snapshot={computerUseSnapshot}
          onRefresh={() => refreshComputerUseSnapshot(selectedSessionId, { force: true })}
        />
      </div>
    </>
  );
  const shellHeader = (
    <div className="space-y-2 px-4 py-3">
      {/* Single-row header: title + git toolbar + actions */}
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 shrink items-center gap-2">
          <span className="min-w-0 shrink truncate font-sans text-[14px] font-bold tracking-tight text-fg/90">
            {resolvedTitle}
          </span>
          {showClaudeCacheTimer ? (
            <ClaudeCacheTtlBadge idleSinceAt={selectedSession?.idleSinceAt} />
          ) : null}
        </div>

        {laneId ? <ChatGitToolbar laneId={laneId} /> : null}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {laneId ? <ChatTerminalToggle open={terminalDrawerOpen} onToggle={() => setTerminalDrawerOpen((v) => !v)} /> : null}
          {resolvedChips.map((chip) => (
            <span
              key={`${chip.label}:${chip.tone ?? "accent"}`}
              className={cn(
                "inline-flex items-center rounded-full border px-2 py-0.5 font-sans text-[9px] font-medium",
                chatChipToneClass(chip.tone),
              )}
            >
              {chip.label}
            </span>
          ))}
          {canShowHandoff ? (
            <div ref={handoffRef} className="relative">
              <button
                type="button"
                className="inline-flex items-center rounded-lg border border-violet-400/[0.12] bg-violet-500/[0.04] px-2.5 py-1 font-sans text-[10px] font-medium text-violet-200/60 transition-colors hover:border-violet-400/20 hover:bg-violet-500/[0.08] hover:text-violet-200/80 disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  setError(null);
                  setHandoffOpen((current) => !current);
                }}
                disabled={handoffBlocked}
                title={handoffButtonTitle}
              >
                Handoff
              </button>
              {handoffOpen ? (
                <div className="absolute right-0 top-full z-[100] mt-2 w-[min(24rem,calc(100vw-2rem))] rounded-[14px] border border-violet-400/[0.10] bg-[#151325]/95 p-4 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.55)] backdrop-blur-[40px]">
                  <div className="space-y-1">
                    <div className="font-sans text-[12px] font-semibold text-fg/82">Start a sibling chat on another model</div>
                    <div className="text-[11px] leading-5 text-fg/54">
                      ADE will create a new work chat, inject a handoff summary from this session, and route you into the new tab.
                    </div>
                  </div>
                  <div className="mt-3">
                    <ProviderModelSelector
                      value={handoffModelId}
                      onChange={setHandoffModelId}
                      availableModelIds={handoffAvailableModelIds}
                      showReasoning
                      onOpenAiSettings={openAiProvidersSettings}
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
          {!lockedSingleSessionMode && selectedSessionId && selectedSession?.status !== "ended" ? (
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-white/[0.06] px-2 py-0.5 font-sans text-[10px] font-medium text-muted-fg/50 transition-colors hover:border-white/[0.1] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              onClick={handleEndSelectedChat}
              disabled={closingChatSessionId === selectedSessionId || deletingChatSessionId === selectedSessionId}
            >
              {closingChatSessionId === selectedSessionId ? "Ending..." : "End chat"}
            </button>
          ) : null}
          {!lockedSingleSessionMode && selectedSessionId && selectedSession?.status === "ended" ? (
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-red-500/20 px-2 py-0.5 font-sans text-[10px] font-medium text-red-200/70 transition-colors hover:border-red-500/30 hover:text-red-100 disabled:cursor-not-allowed disabled:opacity-40"
              onClick={handleDeleteSelectedChat}
              disabled={deletingChatSessionId === selectedSessionId}
            >
              {deletingChatSessionId === selectedSessionId ? "Deleting..." : "Delete chat"}
            </button>
          ) : null}
          {isPersistentIdentitySurface && selectedSessionId ? (
            <button
              type="button"
              className="inline-flex items-center rounded-md border border-white/[0.06] px-2 py-0.5 font-sans text-[10px] font-medium text-muted-fg/50 transition-colors hover:border-white/[0.1] hover:text-fg"
              onClick={() => {
                clearSessionView(selectedSessionId);
              }}
            >
              Clear view
            </button>
          ) : null}
        </div>
      </div>

      {!lockSessionId && !hideSessionTabs ? (
        <div className="flex items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pb-1">
            {sessions.map((session) => {
              const title = chatSessionTitle(session);
              const isActive = session.sessionId === selectedSessionId;
              const sessionNeedsInput = Boolean(pendingInputsBySession[session.sessionId]?.length) || session.awaitingInput === true;
              const isRunning = !sessionNeedsInput && turnActiveBySession[session.sessionId] === true;
              const sessionReadyForPrompt = !sessionNeedsInput && !isRunning && session.status === "idle";
              const sessionIndicatorStatus = sessionNeedsInput || sessionReadyForPrompt
                ? "waiting"
                : isRunning
                  ? "working"
                  : null;
              const sessionIndicatorLabel = sessionNeedsInput
                ? "Waiting for your input"
                : sessionReadyForPrompt
                  ? "Ready for next prompt"
                  : "Agent working";
              return (
                <button
                  key={session.sessionId}
                  type="button"
                  className={cn(
                    "inline-flex shrink-0 items-center gap-2 rounded-lg border px-3 py-1.5 font-sans text-[11px] transition-all",
                    isActive
                      ? "border-violet-400/15 bg-violet-500/[0.06] font-semibold text-fg/90 shadow-[inset_0_-2px_0_rgba(167,139,250,0.6),0_0_12px_rgba(167,139,250,0.06)]"
                      : "border-transparent text-muted-fg/40 hover:text-fg/60 hover:bg-white/[0.03]",
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
                      aria-label={sessionIndicatorLabel}
                      title={sessionIndicatorLabel}
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
            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-violet-400/25 bg-violet-500/[0.06] text-violet-300/60 transition-all hover:border-violet-400/35 hover:bg-violet-500/[0.12] hover:text-violet-200"
            title="New chat"
            onClick={() => {
              pendingSelectedSessionIdRef.current = null;
              draftSelectionLockedRef.current = true;
              setError(null);
              setSelectedSessionId(null);
              setDraft("");
              setAttachments([]);
            }}
          >
            <Plus size={10} weight="bold" />
          </button>
        </div>
      ) : null}
    </div>
  );

  const embedDraft = embeddedWorkLayout && forceDraft;
  const compactShell = embedDraft || layoutVariant === "grid-tile";
  const isEmptyState = !selectedSessionId;

  const composerElement = (
          <AgentChatComposer
            surfaceMode={surfaceMode}
            layoutVariant={layoutVariant}
            composerMaxHeightPx={composerMaxHeightPx}
            isActive={layoutVariant === "grid-tile" ? isTileActive : false}
            shouldAutofocus={layoutVariant === "grid-tile" ? shouldAutofocusComposer : false}
            sdkSlashCommands={sdkSlashCommands}
            modelId={modelId}
            availableModelIds={effectiveAvailableModelIds}
            reasoningEffort={reasoningEffort}
            draft={draft}
            attachments={attachments}
            pendingInput={pendingInput?.request ?? null}
            approvalResponding={pendingInput ? respondingApprovalIds.has(pendingInput.itemId) : false}
            turnActive={turnActive}
            sendOnEnter={sendOnEnter}
            busy={busy}
            sessionProvider={sessionProvider}
            interactionMode={interactionMode}
            claudePermissionMode={claudePermissionMode}
            codexApprovalPolicy={codexApprovalPolicy}
            codexSandbox={codexSandbox}
            codexConfigSource={codexConfigSource}
            opencodePermissionMode={opencodePermissionMode}
            cursorModeSnapshot={effectiveCursorModeSnapshot}
            executionMode={selectedExecutionMode?.value ?? "focused"}
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
            onOpenCodePermissionModeChange={(value) => { void updateNativeControls({ opencodePermissionMode: value }); }}
            onCursorModeChange={(value) => { void updateNativeControls({ cursorModeId: value }); }}
            onCursorConfigChange={(configId, value) => {
              void updateNativeControls({
                cursorConfigValues: {
                  ...nativeControlsRef.current.cursorConfigValues,
                  [configId]: value,
                },
              });
            }}
            onComputerUsePolicyChange={handleComputerUsePolicyChange}
            onToggleProof={() => setProofDrawerOpen((current) => !current)}
            onOpenAiSettings={openAiProvidersSettings}
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
                if (
                  selectedSessionId
                  && snapshot.nextDesc?.isCliWrapped
                  && (snapshot.nextDesc.family === "anthropic" || snapshot.nextDesc.family === "cursor")
                ) {
                  window.ade.agentChat.warmupModel({
                    sessionId: selectedSessionId,
                    modelId: nextModelId,
                  }).catch(() => { /* warmup is best-effort */ });
                }
                return;
              }

              setSessionMutationKind("model");
              const nextOpenCodeModeForPayload = snapshot.resetOpenCodePermissionToDefault
                ? (snapshot.nextOpenCodePermissionMode ?? initialNativeControls.opencodePermissionMode)
                : snapshot.nextOpenCodePermissionMode;
              const nextNativeControlPayload = snapshot.nextProvider === "opencode" && nextOpenCodeModeForPayload != null
                ? {
                    ...summarizeNativeControls("opencode", {
                      ...currentNativeControls,
                      opencodePermissionMode: nextOpenCodeModeForPayload,
                    }),
                  }
                : buildNativeControlPayload(snapshot.nextProvider);
              void window.ade.agentChat.updateSession({
                sessionId: selectedSessionId,
                modelId: nextModelId,
                reasoningEffort: snapshot.nextReasoningEffort,
                ...nextNativeControlPayload,
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
                  opencodePermissionMode: updatedSession.opencodePermissionMode,
                  cursorModeId: updatedSession.cursorModeId,
                  cursorModeSnapshot: updatedSession.cursorModeSnapshot,
                });
                window.ade.agentChat.slashCommands({ sessionId: selectedSessionId })
                  .then(setSdkSlashCommands)
                  .catch(() => {});
                if (
                  snapshot.nextDesc?.isCliWrapped
                  && (snapshot.nextDesc.family === "anthropic" || snapshot.nextDesc.family === "cursor")
                ) {
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
            onApproval={(decision, responseText) => {
              void approve(decision, responseText);
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
            chatHasMessages={selectedEventsForDisplay.some((env) => env.event.type === "user_message" || env.event.type === "text")}
            pendingSteers={pendingSteers}
            onCancelSteer={(steerId) => {
              if (selectedSessionId) {
                void window.ade.agentChat.cancelSteer({ sessionId: selectedSessionId, steerId });
              }
            }}
            onEditSteer={(steerId, text) => {
              if (selectedSessionId) {
                void window.ade.agentChat.editSteer({ sessionId: selectedSessionId, steerId, text });
              }
            }}
            sessionId={selectedSessionId}
          />
  );

  return (
    <>
      <ChatSurfaceShell
        containerRef={shellRef}
        mode={surfaceMode}
        accentColor={presentation?.accentColor ?? draftAccent}
        contentScale={chatUiScale}
        className={compactShell ? cn("border-0 shadow-none rounded-none bg-transparent") : undefined}
        header={compactShell ? undefined : shellHeader}
        footer={isEmptyState ? undefined : composerElement}
        footerClassName={compactShell ? "px-0 pb-0 pt-0" : undefined}
        bodyClassName="flex min-h-0 flex-col overflow-hidden"
      >
        {error ? (
          <div className="border-b border-red-500/[0.08] bg-red-500/[0.03] px-4 py-2.5 font-sans text-[11px] text-red-300/80">
            {error}
          </div>
        ) : null}
        {mergedRuntimeBanner?.kind === "cli-only" ? (
          <div className="border-b border-amber-500/10 bg-amber-500/[0.04] px-4 py-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200/70">
              {mergedRuntimeBanner.cliTitle}
            </div>
            <div className="mt-1 text-[12px] leading-5 text-amber-100/80">
              {mergedRuntimeBanner.cliBody}
            </div>
          </div>
        ) : null}
        {mergedRuntimeBanner?.kind === "local-only" ? (
          <LocalRuntimeNoticeBlock
            notice={mergedRuntimeBanner.localNotice}
            endpoint={mergedRuntimeBanner.localEndpoint}
          />
        ) : null}
        {mergedRuntimeBanner?.kind === "merged" ? (
          <div className="border-b border-amber-500/10 bg-amber-500/[0.04] px-4 py-2.5">
            <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-amber-200/70">
              Runtime status
            </div>
            <div className="mt-3 space-y-3">
              <div>
                <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200/55">
                  {mergedRuntimeBanner.cliTitle}
                </div>
                <div className="mt-1 text-[12px] leading-5 text-amber-100/80">
                  {mergedRuntimeBanner.cliBody}
                </div>
              </div>
              <div className="border-t border-white/[0.06] pt-3">
                <LocalRuntimeNoticeBlock
                  variant="inline"
                  notice={mergedRuntimeBanner.localNotice}
                  endpoint={mergedRuntimeBanner.localEndpoint}
                />
              </div>
            </div>
          </div>
        ) : null}

        <div className="relative min-h-0 flex-1 overflow-hidden">
          {loading && !embedDraft && !selectedSessionId ? (
            <div className="flex h-full items-center justify-center">
              <div className="flex flex-col items-center gap-4">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 rounded-full bg-violet-400/60 ade-thinking-pulse" style={{ animationDelay: '0s' }} />
                  <span className="h-2 w-2 rounded-full bg-violet-400/60 ade-thinking-pulse" style={{ animationDelay: '0.16s' }} />
                  <span className="h-2 w-2 rounded-full bg-violet-400/60 ade-thinking-pulse" style={{ animationDelay: '0.32s' }} />
                </div>
                <span className="font-sans text-[11px] font-medium tracking-widest text-muted-fg/30 uppercase">Loading sessions</span>
              </div>
            </div>
          ) : (
            <AnimatePresence mode="sync">
              {selectedSessionId ? (
                <motion.div
                  key="chat-view"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.25, ease: "easeOut", delay: 0.15 }}
                  className="absolute inset-0 flex min-h-0 overflow-hidden"
                >
                  {/* Chat column */}
                  <div className={cn(
                    "flex min-h-0 flex-1 flex-col overflow-hidden",
                    layoutVariant === "grid-tile" ? "min-w-0" : "min-w-[280px]",
                  )}>
                    <AgentChatMessageList
                      key={selectedSessionId ?? "chat-draft"}
                      events={selectedEventsForDisplay}
                      showStreamingIndicator={turnActive && selectedSession?.status !== "ended"}
                      sessionEnded={selectedSession?.status === "ended"}
                      className="min-h-0 border-0"
                      surfaceMode={surfaceMode}
                      surfaceProfile={surfaceProfile}
                      assistantLabel={assistantLabel}
                      respondingApprovalIds={respondingApprovalIds}
                      pendingApprovalIds={pendingApprovalIds}
                      sessionId={selectedSessionId}
                      onApproval={(itemId, decision, responseText, answers) => {
                        void handleApproval(itemId, decision, responseText, answers);
                      }}
                    />
                    {sessionDelta ? (
                      <div className="flex items-center gap-3 border-t border-white/[0.05] px-4 py-2 font-mono text-[11px]">
                        <span className="text-emerald-400/75">+{sessionDelta.insertions}</span>
                        <span className="text-red-400/75">-{sessionDelta.deletions}</span>
                      </div>
                    ) : null}
                    {selectedTodoItems.length ? (
                      <ChatTasksPanel items={selectedTodoItems} />
                    ) : null}
                    {selectedSubagentSnapshots.length ? (
                      <ChatSubagentsPanel
                        snapshots={selectedSubagentSnapshots}
                        events={selectedEvents}
                        onInterruptTurn={turnActive ? () => { void interrupt(); } : undefined}
                      />
                    ) : null}
                    {selectedTurnDiffSummaries.length && selectedSessionId ? (
                      <ChatFileChangesPanel
                        summaries={selectedTurnDiffSummaries}
                        sessionId={selectedSessionId}
                      />
                    ) : null}
                    <ChatTerminalDrawer
                      open={terminalDrawerOpen}
                      onToggle={() => setTerminalDrawerOpen((v) => !v)}
                      laneId={laneId}
                    />
                  </div>

                  {/* Proof panel (push) */}
                  {proofDrawerOpen ? (
                    layoutVariant === "grid-tile" ? (
                      <div className="absolute inset-3 z-10 flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[color:color-mix(in_srgb,var(--chat-panel-bg-strong)_92%,black_8%)] shadow-[var(--chat-shell-shadow)] backdrop-blur-xl">
                        {proofPanelContent}
                      </div>
                    ) : (
                      <div className="flex h-full w-[40%] min-w-[280px] max-w-[480px] shrink-0 flex-col border-l border-white/[0.06] bg-surface/80">
                        {proofPanelContent}
                      </div>
                    )
                  ) : null}
                </motion.div>
              ) : (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2, ease: "easeIn" } }}
                  className="absolute inset-0 flex flex-col items-center justify-center px-6"
                >
                  <div className="flex w-full max-w-[820px] flex-col items-center gap-4 text-center">
                    <motion.div
                      className="relative"
                      exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.3, ease: "easeOut" } }}
                    >
                      <div
                        className="pointer-events-none absolute top-1/2 left-1/2 h-[360px] w-[360px] -translate-x-1/2 -translate-y-1/2 rounded-full"
                        style={{ background: "var(--color-accent)", opacity: 0.08, filter: "blur(110px)" }}
                      />
                      <img
                        src="./logo.png"
                        alt="ADE"
                        className="relative z-10 h-96 w-96 object-contain"
                        style={{ filter: "drop-shadow(0 0 40px rgba(168,130,255,0.15))" }}
                      />
                    </motion.div>

                    <h2 className="font-sans text-[18px] font-semibold tracking-tight text-fg/80">
                      Start a new conversation
                    </h2>
                    <p className="max-w-sm text-center text-[13px] leading-relaxed text-fg/35">
                      Ask ADE anything — refactor code, debug issues, or explore ideas.
                    </p>

                    {/* Lane selector pill */}
                    {availableLanes && availableLanes.length > 0 && onLaneChange ? (
                      <motion.div
                        exit={{ opacity: 0, transition: { duration: 0.15 } }}
                      >
                        <select
                          aria-label="Select lane"
                          value={laneId ?? ""}
                          onChange={(e) => onLaneChange(e.target.value)}
                          className="appearance-none rounded-full px-4 py-1.5 text-[11px] font-medium text-fg/70 outline-none transition-colors cursor-pointer"
                          style={{
                            background: "rgba(255,255,255,0.04)",
                            border: "1px solid rgba(255,255,255,0.08)",
                            backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='rgba(255,255,255,0.4)' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E")`,
                            backgroundRepeat: "no-repeat",
                            backgroundPosition: "right 10px center",
                            paddingRight: "28px",
                          }}
                        >
                          {availableLanes.map((lane) => (
                            <option key={lane.id} value={lane.id}>
                              {lane.name}
                            </option>
                          ))}
                        </select>
                      </motion.div>
                    ) : laneDisplayLabel ? (
                      <motion.div
                        className="flex items-center gap-2 rounded-full px-4 py-1.5"
                        style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                        exit={{ opacity: 0, transition: { duration: 0.15 } }}
                      >
                        <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: draftAccent }} />
                        <span className="text-[11px] font-medium text-fg/60">{laneDisplayLabel}</span>
                      </motion.div>
                    ) : null}

                    {/* Inline composer for empty state */}
                    <div className="w-full max-w-[820px]">
                      {composerElement}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </ChatSurfaceShell>
    </>
  );
}
