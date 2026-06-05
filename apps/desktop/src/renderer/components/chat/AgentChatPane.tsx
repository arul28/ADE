import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { CircleNotch, Cube, Desktop, DeviceMobile, ArrowBendUpRight, Lightning, Plus, Terminal, TreeStructure, X } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  mergeAttachments,
  PARALLEL_CHAT_MAX_ATTACHMENTS,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatCursorConfigValue,
  type AgentChatDroidPermissionMode,
  type AgentChatExecutionMode,
  type AgentChatEventEnvelope,
  type AgentChatEventHistorySnapshot,
  type AgentChatContextAttachment,
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AiProviderConnectionStatus,
  type AiRuntimeConnectionStatus,
  type AgentChatSession,
  type AgentChatSubagentTranscriptMessage,
  type AgentChatOpenCodePermissionMode,
  type AgentChatPermissionMode,
  type AgentChatParallelLaunchState,
  type AgentChatSessionProfile,
  type ChatSurfaceChip,
  type ChatSurfaceProfile,
  type ChatSurfacePresentation,
  type AgentChatSessionSummary,
  type CodexThreadGoal,
  type CodexThreadTokenUsage,
  type BuiltInBrowserContextItem,
  type ComputerUseOwnerSnapshot,
  type AppControlContextItem,
  type IosElementContextItem,
  type IosSimulatorDrawerMode,
  type LaneLinearIssue,
  type AiSettingsStatus,
  type MacosVmContextItem,
  type TerminalSessionDetail,
  type TerminalToolType,
} from "../../../shared/types";
import {
  buildChatContextAttachmentPrompt,
  makeLinearIssueContextAttachment,
  makeOrchestrationAnnotationContextAttachment,
  mergeChatContextAttachments,
  normalizeChatContextAttachments,
  removeChatContextAttachment,
} from "../../../shared/chatContextAttachments";
import type {
  OrchestrationAnnotationEventDetail,
  OrchestrationContextItem,
} from "../../../shared/types/orchestration";
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
  getRuntimeModelRefForDescriptor,
  modelSupportsFastMode,
  parseLocalProviderFromModelId,
  resolveCursorCliModelVariant,
  resolveCliProviderForModel,
  resolveProviderGroupForModel,
  resolveModelDescriptorForProvider,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { CURSOR_AVAILABLE_MODE_IDS } from "../../../shared/cursorModes";
import { cn } from "../ui/cn";
import { AgentChatComposer, type ParallelComposerControlSlot } from "./AgentChatComposer";
import { resolveModelDescriptorWithRuntimeCatalog, descriptorsFromAgentChatModelCatalog } from "../shared/ModelPicker/modelCatalog";
import { getSharedRuntimeCatalog } from "../shared/ModelPicker/runtimeCatalogCache";
import { familiesFromStatus } from "../shared/ModelPicker/useProviderAuthStatus";
import { AgentChatMessageList } from "./AgentChatMessageList";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { isChatToolType } from "../../lib/sessions";
import { ToolLogo } from "../terminals/ToolLogos";
import { deriveConfiguredModelIds, isKnownSelectableChatModelId } from "../../lib/modelOptions";
import {
  compareChatSessionsByEffectiveRecency,
  getChatSessionLocalTouchTimestampForEvent,
  shouldRefreshSessionListForChatEvent,
} from "../../lib/chatSessionEvents";
import { SmartTooltip } from "../ui/SmartTooltip";
import { CHAT_SHELL_HEADER_CLASS, ChatSurfaceShell } from "./ChatSurfaceShell";
import { OrchestratorLeadFrame } from "./OrchestratorLeadFrame";
import { OrchestrationPanel } from "../orchestration/OrchestrationPanel";
import { chatChipToneClass, providerChatAccent } from "./chatSurfaceTheme";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";
import { ChatAppControlPanel } from "./ChatAppControlPanel";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import { ChatTasksPanel } from "./ChatTasksPanel";
import { ChatFileChangesPanel } from "./ChatFileChangesPanel";
import { CodexOpenInCliButton } from "./codex/CodexOpenInCliButton";
import { RewindFilesConfirmDialog, type RewindFilesConfirmDialogState } from "./RewindFilesConfirmDialog";
import { buildRewindPreviewFiles, deriveRewindDiffSummaries } from "./rewindFilesPreview";
import { ChatCursorCloudPanel, type ChatCursorCloudPanelHandle } from "./ChatCursorCloudPanel";
import { CursorCloudInlineLaunch, type CursorCloudInlineLaunchHandle } from "./CursorCloudInlineLaunch";
import { QuickRunMenu } from "../run/QuickRunMenu";
import { ChatGitToolbar } from "./ChatGitToolbar";
import { LaneChip } from "../terminals/LaneChip";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { openLaneInLanesTabPath } from "../../lib/laneNavigation";
import { ChatTerminalDrawer, ChatTerminalToggle } from "./ChatTerminalDrawer";
import { deriveChatSubagentSnapshots, deriveTodoItems, deriveTurnDiffSummaries } from "./chatExecutionSummary";
import { derivePendingInputRequests, type DerivedPendingInput } from "./pendingInput";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import { ChatActionsDrawerPanel, type ChatActionsTab } from "./ChatActionsDrawerPanel";
import { selectActiveProjectRoot, useAppStore } from "../../state/appStore";
import { buildChatAppearanceRootStyle } from "./chatAppearance";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";
import { LaneAccentDot } from "../lanes/LaneAccentDot";
import { LaneCombobox, AUTO_CREATE_LANE_OPTION_ID } from "../terminals/LaneCombobox";
import {
  buildTrackedCliLaunchCommand,
  LAUNCH_PROFILE_TITLE,
  type CliProvider,
  type WorkPtyLaunchArgs,
  type WorkPtyLaunchResult,
} from "../terminals/cliLaunch";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { WorkSurfaceHeader } from "../work/WorkSurfaceHeader";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import {
  invalidateAgentChatSessionListCache,
  listAgentChatSessionsCached,
} from "../../lib/agentChatSessionListCache";
import { getAgentChatSlashCommandsCached } from "../../lib/agentChatSlashCommandsCache";
import { getAgentChatModelsCached, getAiStatusCached, invalidateAiDiscoveryCache, peekAiStatusCached } from "../../lib/aiDiscoveryCache";
import { getProjectConfigCached } from "../../lib/projectConfigCache";
import { invalidateSessionListCache } from "../../lib/sessionListCache";
import {
  isDraftLaunchJobStale,
  isDraftLaunchJobTerminal,
  pruneDraftLaunchJobs,
  type BackgroundLaunchNotice,
  type DraftLaunchJob,
  type DraftLaunchKind,
  type DraftLaunchMode,
  type DraftLaunchSnapshot,
  type NativeControlState,
  type PreparedDraftLaunch,
} from "../../lib/draftLaunchJobs";
import {
  buildAutomaticMacosVmContextForPrompt,
  createAppControlContextInstanceId,
  createBuiltInBrowserContextInstanceId,
  createIosContextInstanceId,
  createMacosVmContextInstanceId,
  formatAppControlContextChipsForDisplay,
  formatAppControlContextForPrompt,
  formatBuiltInBrowserContextChipsForDisplay,
  formatBuiltInBrowserContextForPrompt,
  formatIosElementContextChipsForDisplay,
  formatIosElementContextForPrompt,
  formatMacosVmContextChipsForDisplay,
  formatMacosVmContextForPrompt,
  getAppControlContextAttachmentPath,
  getBuiltInBrowserContextAttachmentPath,
  getIosContextAttachmentPath,
  iosContextSurface,
  normalizeBuiltInBrowserContextItem,
  stripDataUrlPrefix,
} from "../../lib/visualContextFormatting";

import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";
const LAST_LAUNCH_CONFIG_KEY_PREFIX = "ade.chat.lastLaunchConfig.v1";
const COMPOSER_DRAFT_STORAGE_KEY_PREFIX = "ade.chat.composerDraft.v1";
const COMPOSER_DRAFT_WRITE_DEBOUNCE_MS = 350;
const SUBAGENT_AUTOOPEN_FIRED_KEY_PREFIX = "ade.chat.subagentAutoOpenFired";
const SUBAGENT_AUTOOPEN_FIRED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const workCliStartupDelayMs = 180;
const REMOTE_PARALLEL_LAUNCH_RECOVERY_DELAY_MS = 15_000;
export const DEFAULT_PARALLEL_ATTACHMENT_REQUEST = "Please review the attached files.";

const chatToolbarActionBase =
  "relative inline-flex h-6 shrink-0 items-center gap-1 rounded-md border px-2 font-sans text-[10px] font-medium transition-colors";
const chatToolbarActionIdle =
  "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.10] hover:text-fg/65";

const AUTO_CREATE_LANE_OPTION = {
  id: AUTO_CREATE_LANE_OPTION_ID,
  name: "Auto-create lane",
  color: null,
  branchRef: null,
};

const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;

type SubagentAutoOpenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function getSubagentAutoOpenStorageKey(sessionId: string): string {
  return `${SUBAGENT_AUTOOPEN_FIRED_KEY_PREFIX}:${sessionId}`;
}

function encodeSubagentAutoOpenRecord(nowMs: number): string {
  return JSON.stringify({ firedAt: nowMs });
}

function parseSubagentAutoOpenFiredAt(raw: string | null): number | "legacy" | null {
  if (!raw) return null;
  if (raw === "1") return "legacy";
  try {
    const parsed = JSON.parse(raw) as { firedAt?: unknown };
    return typeof parsed.firedAt === "number" && Number.isFinite(parsed.firedAt)
      ? parsed.firedAt
      : null;
  } catch {
    return null;
  }
}

export function cleanupSubagentAutoOpenStorage(storage: SubagentAutoOpenStorage, nowMs = Date.now()): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${SUBAGENT_AUTOOPEN_FIRED_KEY_PREFIX}:`)) keys.push(key);
  }
  for (const key of keys) {
    const firedAt = parseSubagentAutoOpenFiredAt(storage.getItem(key));
    if (firedAt === "legacy") {
      storage.setItem(key, encodeSubagentAutoOpenRecord(nowMs));
    } else if (firedAt === null || nowMs - firedAt > SUBAGENT_AUTOOPEN_FIRED_TTL_MS) {
      storage.removeItem(key);
    }
  }
}

function hasSubagentAutoOpenFired(storage: SubagentAutoOpenStorage, sessionId: string, nowMs = Date.now()): boolean {
  const key = getSubagentAutoOpenStorageKey(sessionId);
  const firedAt = parseSubagentAutoOpenFiredAt(storage.getItem(key));
  if (firedAt === "legacy") {
    storage.setItem(key, encodeSubagentAutoOpenRecord(nowMs));
    return true;
  }
  if (firedAt === null) {
    storage.removeItem(key);
    return false;
  }
  if (nowMs - firedAt > SUBAGENT_AUTOOPEN_FIRED_TTL_MS) {
    storage.removeItem(key);
    return false;
  }
  return true;
}
const CHAT_HISTORY_READ_MAX_BYTES = 2_000_000;
const MAX_RETAINED_CHAT_SESSION_HISTORIES = 6;
const MAX_SELECTED_CHAT_SESSION_EVENTS = 20_000;
const MAX_BACKGROUND_CHAT_SESSION_EVENTS = 1_000;
const EMPTY_DRAFT_LAUNCH_JOBS: DraftLaunchJob[] = [];

type DraftLaunchLaneTarget = {
  laneId: string;
  laneName: string;
  worktreePath: string | null;
  autoCreated: boolean;
};

type StartedDraftLaunch = {
  sessionId: string;
  draftKind: DraftLaunchKind;
};

function draftLaunchRequestKey(args: {
  kind: DraftLaunchKind;
  mode: DraftLaunchMode;
  autoCreate: boolean;
  snapshot: DraftLaunchSnapshot;
}): string {
  return JSON.stringify({
    kind: args.kind,
    mode: args.mode,
    autoCreate: args.autoCreate,
    snapshot: args.snapshot,
  });
}

function createTemporaryAutoLaneName(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    "chat",
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  ].join("-");
}

export type AgentChatSessionCreatedOptions = {
  activate?: boolean;
  source?: "chat" | "draft-launch" | "handoff";
};

function buildDraftLaunchNamingSeed(snapshot: DraftLaunchSnapshot): string {
  if (snapshot.text.length) return snapshot.text;
  const imageCount = snapshot.attachments.filter((attachment) => attachment.type === "image").length;
  const fileCount = snapshot.attachments.filter((attachment) => attachment.type === "file").length;
  const issueCount = snapshot.contextAttachments.filter((attachment) => attachment.type === "linear_issue").length;
  const parts = [
    "New chat task",
    imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
    fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
    issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.join(" - ");
}

function createDraftLaunchJobId(): string {
  try {
    const uuid = globalThis.crypto?.randomUUID?.();
    if (uuid) return uuid;
  } catch {
    // crypto.randomUUID may throw in insecure contexts; fall through.
  }
  return `draft-launch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function buildDraftLaunchJobTitle(kind: DraftLaunchKind, snapshot: DraftLaunchSnapshot): string {
  return workCliTitleFromPrompt(
    buildDraftLaunchNamingSeed(snapshot),
    kind === "cli" ? "CLI session" : "Chat",
  );
}

function draftLaunchKindLabel(kind: DraftLaunchKind): string {
  return kind === "cli" ? "CLI session" : "chat";
}

function draftLaunchJobLabel(job: DraftLaunchJob): string {
  if (job.status === "naming-lane" || job.status === "creating-lane") return "Auto-create lane";
  if (job.status === "failed") return "Launch failed";
  if (job.status === "ready") return job.mode === "background" ? "Background launch" : "Ready";
  return job.draftKind === "cli" ? "CLI launch" : "Chat launch";
}

function draftLaunchJobMessage(job: DraftLaunchJob): string {
  const laneSuffix = job.laneName ? ` in ${job.laneName}` : "";
  if (job.status === "naming-lane") return `Creating lane for ${draftLaunchKindLabel(job.draftKind)}... Choosing a branch name.`;
  if (job.status === "creating-lane") return `Creating lane for ${draftLaunchKindLabel(job.draftKind)}...`;
  if (job.status === "starting-session") return `Starting ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}...`;
  if (job.status === "sending-prompt") return `Sending prompt to ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}...`;
  if (job.status === "failed") return job.error ? `Launch failed: ${job.error}` : "Launch failed.";
  return job.mode === "background"
    ? `Launched ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}.`
    : `Ready to open ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}.`;
}

function staleDraftLaunchJobMessage(job: DraftLaunchJob): string {
  return `${draftLaunchJobMessage(job)} Still working. You can hide this status while ADE continues in the background.`;
}

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
  if (model.family === "factory") {
    return [
      {
        value: "focused",
        label: "Focused",
        summary: "Single thread",
        helper: "Keep the turn in one Droid session unless the task clearly benefits from delegation.",
        accent: "#A1A1AA",
      },
      {
        value: "parallel",
        label: "Parallel",
        summary: "Droid delegates",
        helper: "Tell Droid to use available delegation tools for independent subtasks, then reconcile the result.",
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
    } else if (event.type === "user_message" && event.steerId) {
      if (event.deliveryState === "queued") {
        if (!resolvedSteerIds.has(event.steerId)) {
          steerMap.set(event.steerId, { steerId: event.steerId, text: event.text });
        }
      } else {
        // "inline" / "delivered" / "failed" — the steer left the queue, so
        // clear it from the display. Without this the chip stays staged after
        // the user clicks "Send Now" or after a queued steer is delivered.
        steerMap.delete(event.steerId);
        resolvedSteerIds.add(event.steerId);
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

type AgentChatSessionViewCache = {
  events: AgentChatEventEnvelope[];
  turnActive: boolean;
  pendingInputs: DerivedPendingInput[];
  pendingSteers: PendingSteerEntry[];
  cachedAtMs: number;
};

const MAX_AGENT_CHAT_VIEW_CACHE_ENTRIES = 32;
const AGENT_CHAT_VIEW_CACHE_ENABLED = import.meta.env.MODE !== "test";
const agentChatSessionViewCacheBySessionId = new Map<string, AgentChatSessionViewCache>();

function readAgentChatSessionViewCache(sessionId: string | null | undefined): AgentChatSessionViewCache | null {
  if (!AGENT_CHAT_VIEW_CACHE_ENABLED) return null;
  if (!sessionId) return null;
  const cached = agentChatSessionViewCacheBySessionId.get(sessionId) ?? null;
  if (!cached) return null;
  agentChatSessionViewCacheBySessionId.delete(sessionId);
  agentChatSessionViewCacheBySessionId.set(sessionId, cached);
  return cached;
}

function writeAgentChatSessionViewCache(
  sessionId: string,
  events: AgentChatEventEnvelope[],
  derived = deriveRuntimeState(events),
): void {
  if (!AGENT_CHAT_VIEW_CACHE_ENABLED) return;
  const trimmed = trimChatEventHistory(events, MAX_SELECTED_CHAT_SESSION_EVENTS);
  agentChatSessionViewCacheBySessionId.delete(sessionId);
  agentChatSessionViewCacheBySessionId.set(sessionId, {
    events: trimmed,
    turnActive: derived.turnActive,
    pendingInputs: derived.pendingInputs,
    pendingSteers: derived.pendingSteers,
    cachedAtMs: Date.now(),
  });
  while (agentChatSessionViewCacheBySessionId.size > MAX_AGENT_CHAT_VIEW_CACHE_ENTRIES) {
    const oldest = agentChatSessionViewCacheBySessionId.keys().next().value;
    if (!oldest) break;
    agentChatSessionViewCacheBySessionId.delete(oldest);
  }
}

function deleteAgentChatSessionViewCache(sessionId: string): void {
  if (!AGENT_CHAT_VIEW_CACHE_ENABLED) return;
  agentChatSessionViewCacheBySessionId.delete(sessionId);
}

type LastLaunchConfig = {
  version: 1;
  modelId: string;
  reasoningEffort: string | null;
  codexFastMode: boolean;
  executionMode: AgentChatExecutionMode;
  controls: NativeControlState;
  updatedAt: string;
};

type ComposerDraftStorageSnapshot = {
  version: 1;
  text: string;
  modelId: string;
  reasoningEffort: string | null;
  codexFastMode: boolean;
  executionMode: AgentChatExecutionMode;
  controls: NativeControlState;
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
  iosContextItems: IosElementContextItem[];
  appControlContextItems: AppControlContextItem[];
  builtInBrowserContextItems: BuiltInBrowserContextItem[];
  macosVmContextItems: MacosVmContextItem[];
  draftLaunchTargetId: string | null;
  updatedAt: string;
};

type ParallelModelRowState = NativeControlState & {
  modelId: string;
  reasoningEffort: string | null;
  codexFastMode: boolean;
  executionMode: AgentChatExecutionMode;
};

type WorkDraftLaunchKind = "chat" | "cli" | "chat-orchestrator";
type WorkDraftStorageKind = WorkDraftLaunchKind | "work-start";

function normalizeWorkDraftStorageKind(workDraftKind: WorkDraftLaunchKind): WorkDraftStorageKind {
  return workDraftKind === "chat" || workDraftKind === "cli" ? "work-start" : workDraftKind;
}

function resolveWorkDraftStorageKind(workDraftKind: WorkDraftLaunchKind | WorkDraftStorageKind): WorkDraftStorageKind {
  return workDraftKind === "work-start" ? "work-start" : normalizeWorkDraftStorageKind(workDraftKind);
}

function launchConfigStorageKey(scope: {
  projectRoot: string | null | undefined;
  laneId: string | null | undefined;
  surfaceProfile: ChatSurfaceProfile;
  workDraftKind: WorkDraftStorageKind;
}): string {
  return [
    LAST_LAUNCH_CONFIG_KEY_PREFIX,
    scope.projectRoot?.trim() || "project",
    scope.laneId?.trim() || "no-lane",
    scope.surfaceProfile,
    scope.workDraftKind,
  ].map(encodeURIComponent).join(":");
}

function launchConfigStorageKeys(scope: {
  projectRoot: string | null | undefined;
  laneId: string | null | undefined;
  surfaceProfile: ChatSurfaceProfile;
  workDraftKind: WorkDraftLaunchKind | WorkDraftStorageKind;
}): string[] {
  const sharedKind = resolveWorkDraftStorageKind(scope.workDraftKind);
  const keys = [
    launchConfigStorageKey({ ...scope, workDraftKind: sharedKind }),
  ];
  if (sharedKind === "work-start") {
    keys.push(
      launchConfigStorageKey({ ...scope, workDraftKind: "chat" }),
      launchConfigStorageKey({ ...scope, workDraftKind: "cli" }),
    );
  }
  return [...new Set(keys)];
}

function composerDraftStorageKey(scope: {
  projectRoot: string | null | undefined;
  companionStateKey: string;
  surfaceProfile: ChatSurfaceProfile;
  workDraftKind: WorkDraftStorageKind;
}): string {
  return [
    COMPOSER_DRAFT_STORAGE_KEY_PREFIX,
    scope.projectRoot?.trim() || "project",
    scope.companionStateKey,
    scope.surfaceProfile,
    scope.workDraftKind,
  ].map(encodeURIComponent).join(":");
}

function composerDraftStorageKeys(scope: {
  projectRoot: string | null | undefined;
  companionStateKey: string;
  surfaceProfile: ChatSurfaceProfile;
  workDraftKind: WorkDraftLaunchKind | WorkDraftStorageKind;
}): string[] {
  const sharedKind = resolveWorkDraftStorageKind(scope.workDraftKind);
  const keys = [
    composerDraftStorageKey({ ...scope, workDraftKind: sharedKind }),
  ];
  if (sharedKind === "work-start") {
    keys.push(
      composerDraftStorageKey({ ...scope, workDraftKind: "chat" }),
      composerDraftStorageKey({ ...scope, workDraftKind: "cli" }),
    );
  }
  return [...new Set(keys)];
}

function defaultNativeControls(profile: ChatSurfaceProfile): NativeControlState {
  if (profile === "persistent_identity") {
    return {
      interactionMode: "default",
      claudePermissionMode: "bypassPermissions",
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
      opencodePermissionMode: "full-auto",
      droidPermissionMode: "auto-high",
      cursorModeId: "full-auto",
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
    droidPermissionMode: "auto-low",
    cursorModeId: "agent",
    cursorConfigValues: {},
  };
}

type ChatRuntimeProviderKey = "claude" | "codex" | "cursor" | "droid" | "opencode";

function resolveChatRuntimeProvider(desc: ModelDescriptor | null | undefined): ChatRuntimeProviderKey {
  return desc ? resolveProviderGroupForModel(desc) : "opencode";
}

function runtimeFacingModelId(desc: ModelDescriptor | null | undefined, registryModelId: string): string {
  if (!desc?.isCliWrapped) return registryModelId;
  if (desc.family === "cursor" || desc.family === "openai" || desc.family === "factory") {
    return desc.providerModelId || registryModelId;
  }
  return desc.shortId ?? registryModelId;
}

function nativeControlSliceFromParallelSlot(slot: ParallelModelRowState): NativeControlState {
  const { modelId: _, reasoningEffort: _re, codexFastMode: _cfm, executionMode: _em, ...native } = slot;
  return native;
}

function cloneParallelSlotFromComposer(args: {
  native: NativeControlState;
  modelId: string;
  reasoningEffort: string | null;
  codexFastMode: boolean;
  executionMode: AgentChatExecutionMode;
}): ParallelModelRowState {
  return {
    ...args.native,
    cursorConfigValues: { ...args.native.cursorConfigValues },
    modelId: args.modelId,
    reasoningEffort: args.reasoningEffort,
    codexFastMode: args.codexFastMode,
    executionMode: args.executionMode,
  };
}

function summarizeNativeControls(
  provider: AgentChatSessionSummary["provider"] | "claude" | "codex" | "opencode" | "cursor" | "droid",
  controls: NativeControlState,
): Pick<
  AgentChatSessionSummary,
  "interactionMode" | "claudePermissionMode" | "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource" | "opencodePermissionMode" | "droidPermissionMode" | "permissionMode" | "cursorModeId"
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
    } else if (controls.codexApprovalPolicy === "untrusted" && controls.codexSandbox === "workspace-write") {
      permissionMode = "edit";
    } else if (
      (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "on-failure")
      && controls.codexSandbox === "workspace-write"
    ) {
      permissionMode = "default";
    } else if (
      (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "untrusted")
      && controls.codexSandbox === "read-only"
    ) {
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
  if (provider === "droid") {
    return {
      droidPermissionMode: controls.droidPermissionMode,
      permissionMode: droidPermissionModeToLegacyPermissionMode(controls.droidPermissionMode),
    };
  }
  return {
    opencodePermissionMode: controls.opencodePermissionMode,
    permissionMode: controls.opencodePermissionMode,
  };
}

function droidPermissionModeToLegacyPermissionMode(mode: AgentChatDroidPermissionMode): AgentChatPermissionMode {
  if (mode === "read-only") return "plan";
  if (mode === "auto-low") return "edit";
  if (mode === "auto-medium") return "default";
  return "full-auto";
}

function legacyPermissionModeToDroidPermissionMode(
  mode: AgentChatPermissionMode | undefined,
): AgentChatDroidPermissionMode | undefined {
  if (mode === "plan") return "read-only";
  if (mode === "edit") return "auto-low";
  if (mode === "default") return "auto-medium";
  if (mode === "full-auto") return "auto-high";
  return undefined;
}

function cliPermissionModeFromNativeControls(provider: CliProvider, controls: NativeControlState): AgentChatPermissionMode {
  if (provider === "cursor") {
    const modeId = controls.cursorModeId?.trim().toLowerCase() ?? "";
    if (modeId.includes("full") || modeId.includes("auto")) return "full-auto";
    if (modeId.includes("plan")) return "plan";
    if (modeId.includes("ask")) return "edit";
    return "default";
  }
  return summarizeNativeControls(provider, controls).permissionMode ?? "default";
}

function formatWorkCliAttachmentManifest(attachments: AgentChatFileRef[]): string {
  if (!attachments.length) return "";
  return [
    "Attached files and images:",
    ...attachments.map((attachment, index) => {
      if (attachment.type === "image-url") {
        return `${index + 1}. Image URL: ${attachment.url}`;
      }
      return `${index + 1}. ${attachment.type === "image" ? "Image file" : "File"}: ${attachment.path}`;
    }),
  ].join("\n");
}

function buildWorkCliInitialPrompt(args: {
  text: string;
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
}): string {
  return [
    formatWorkCliAttachmentManifest(args.attachments),
    buildChatContextAttachmentPrompt(args.contextAttachments),
    args.text.trim(),
  ].filter((part) => part.trim().length > 0).join("\n\n");
}

function workCliTitleFromPrompt(seed: string, fallback: string): string {
  const cleaned = seed
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return fallback;
  const withoutSlash = cleaned.startsWith("/") && !isProviderSlashCommandInput(cleaned)
    ? cleaned.slice(1).trim()
    : cleaned;
  const clipped = withoutSlash.length > 56
    ? withoutSlash.slice(0, 56).replace(/\s+\S*$/u, "").trim()
    : withoutSlash;
  const title = (clipped || withoutSlash).replace(/[.?!,:;]+$/u, "").trim();
  return title ? title.charAt(0).toUpperCase() + title.slice(1) : fallback;
}

function createClaudeSessionIdForCliLaunch(): string | undefined {
  try {
    return globalThis.crypto?.randomUUID?.();
  } catch {
    return undefined;
  }
}

/**
 * Build a fallback CursorModeSnapshot when the Cursor SDK runtime hasn't
 * reported its own snapshot yet.
 */
function buildFallbackCursorModeSnapshot(modeId: string | null | undefined): NonNullable<AgentChatSessionSummary["cursorModeSnapshot"]> {
  const normalized = typeof modeId === "string" && modeId.trim().length ? modeId.trim() : "agent";
  return {
    currentModeId: normalized,
    availableModeIds: [...CURSOR_AVAILABLE_MODE_IDS],
  };
}

type HandoffCodexPreset = "default" | "edit" | "plan" | "full-auto" | "config-toml" | "custom";

function resolveHandoffCodexPreset(controls: {
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
}): HandoffCodexPreset {
  if (controls.codexConfigSource === "config-toml") return "config-toml";
  if (controls.codexApprovalPolicy === "untrusted" && controls.codexSandbox === "workspace-write") return "edit";
  if ((controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "on-failure") && controls.codexSandbox === "workspace-write") return "default";
  if ((controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "untrusted") && controls.codexSandbox === "read-only") return "plan";
  if (controls.codexApprovalPolicy === "never" && controls.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

function handoffApplyCodexPreset(
  preset: "default" | "edit" | "plan" | "full-auto" | "config-toml",
  fallbacks: { cap: AgentChatCodexApprovalPolicy; sandbox: AgentChatCodexSandbox },
): Pick<NativeControlState, "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource"> {
  if (preset === "default") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    };
  }
  if (preset === "edit") {
    return {
      codexApprovalPolicy: "untrusted",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    };
  }
  if (preset === "plan") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    };
  }
  if (preset === "config-toml") {
    return {
      codexApprovalPolicy: fallbacks.cap,
      codexSandbox: fallbacks.sandbox,
      codexConfigSource: "config-toml",
    };
  }
  return {
    codexApprovalPolicy: "never",
    codexSandbox: "danger-full-access",
    codexConfigSource: "flags",
  };
}

function clampHandoffReasoningToModel(current: string | null, descriptor: ModelDescriptor | null): string | null {
  if (!descriptor) return null;
  if (!descriptor.capabilities?.reasoning) return null;
  const tiers = descriptor.reasoningTiers ?? [];
  if (!tiers.length) return null;
  if (current && tiers.includes(current)) return current;
  return tiers[0] ?? null;
}

const HANDOFF_CLAUDE_MODES: Array<{ value: AgentChatClaudePermissionMode; label: string }> = [
  { value: "default", label: "Ask permissions" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "auto", label: "Auto" },
  { value: "plan", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
];

const HANDOFF_OPENCODE_MODES: Array<{ value: AgentChatOpenCodePermissionMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
  { value: "config-toml", label: "Config" },
];

const HANDOFF_DROID_MODES: Array<{ value: AgentChatDroidPermissionMode; label: string }> = [
  { value: "read-only", label: "Read-only" },
  { value: "auto-low", label: "Auto low" },
  { value: "auto-medium", label: "Auto medium" },
  { value: "auto-high", label: "Auto high" },
];

const handoffSelectCls = cn(
  "h-8 w-full min-w-0 rounded-md border border-white/[0.06] bg-white/[0.03] px-2 font-sans text-[10px] text-fg/70",
  "outline-none transition-colors duration-150 focus:border-violet-400/30",
);

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
  if (model?.family === "factory" || model?.cliCommand === "droid") return "Droid";
  if (model?.family === "anthropic" || model?.cliCommand === "claude") return "Claude";
  if (model?.family === "openai" || model?.cliCommand === "codex") return "Codex";
  if (sessionProvider === "claude") return "Claude";
  if (sessionProvider === "codex") return "Codex";
  if (sessionProvider === "cursor") return "Cursor";
  if (sessionProvider === "droid") return "Droid";
  return "Assistant";
}

function sortSessionSummariesByRecency(
  rows: AgentChatSessionSummary[],
  localTouchBySession: ReadonlyMap<string, string>,
): AgentChatSessionSummary[] {
  return [...rows].sort((left, right) => compareChatSessionsByEffectiveRecency(left, right, localTouchBySession));
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

function stableSessionDelayOffset(sessionId: string): number {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = ((hash * 31) + sessionId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

function chatEventDedupKey(entry: AgentChatEventEnvelope): string {
  return `${entry.timestamp}#${entry.event.type}#${JSON.stringify(entry.event)}`;
}

function userMessageVisibleText(event: Extract<AgentChatEventEnvelope["event"], { type: "user_message" }>): string {
  const displayText = event.displayText?.trim();
  return displayText?.length ? displayText : event.text.trim();
}

function attachmentMatchKey(attachment: AgentChatFileRef): string {
  return attachment.type === "image-url"
    ? `${attachment.type}:${attachment.path}:${attachment.url}`
    : `${attachment.type}:${attachment.path}`;
}

function contextAttachmentMatchKey(attachment: AgentChatContextAttachment): string {
  switch (attachment.type) {
    case "linear_issue":
      return `${attachment.type}:${attachment.issue.id}`;
    case "orchestration_annotation": {
      const anchor = attachment.item.anchor;
      const anchorId = anchor.id ?? "anon";
      return `${attachment.type}:${attachment.item.runId}:${anchor.kind}:${anchorId}:${attachment.item.capturedAt}`;
    }
  }
}

/**
 * Runtime guard for the OrchestrationContextItem payload arriving via the
 * `ade:agent-chat:add-plan-annotation` CustomEvent. We validate the bare
 * minimum so a malformed event can't crash the renderer.
 */
function isOrchestrationContextItem(value: unknown): value is OrchestrationContextItem {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "orchestration_annotation") return false;
  if (typeof record.runId !== "string" || !record.runId.length) return false;
  if (typeof record.capturedAt !== "string" || !record.capturedAt.length) return false;
  if (typeof record.comment !== "string") return false;
  if (typeof record.selectionExcerpt !== "string") return false;
  const anchor = record.anchor as Record<string, unknown> | null | undefined;
  if (!anchor || typeof anchor !== "object") return false;
  if (typeof anchor.kind !== "string" || !anchor.kind.length) return false;
  if (typeof anchor.preview !== "string") return false;
  return true;
}

function isOrchestrationPlanApprovalRequest(
  request: DerivedPendingInput["request"] | null | undefined,
): boolean {
  return request?.kind === "plan_approval"
    && request.providerMetadata?.orchestrationPlanApproval === true;
}

function sortedMatchKeys<T>(items: T[] | undefined, readKey: (item: T) => string): string[] {
  return (items ?? []).map(readKey).sort((left, right) => left.localeCompare(right));
}

function matchKeyLists(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

export function isMatchingOptimisticUserMessage(
  committed: AgentChatEventEnvelope,
  optimistic: AgentChatEventEnvelope,
): boolean {
  if (committed.sessionId !== optimistic.sessionId) return false;
  if (committed.event.type !== "user_message" || optimistic.event.type !== "user_message") return false;
  if (committed.event.steerId || optimistic.event.steerId) return false;
  if (userMessageVisibleText(committed.event) !== userMessageVisibleText(optimistic.event)) return false;

  return (
    matchKeyLists(
      sortedMatchKeys(committed.event.attachments, attachmentMatchKey),
      sortedMatchKeys(optimistic.event.attachments, attachmentMatchKey),
    )
    && matchKeyLists(
      sortedMatchKeys(committed.event.contextAttachments, contextAttachmentMatchKey),
      sortedMatchKeys(optimistic.event.contextAttachments, contextAttachmentMatchKey),
    )
  );
}

function hasMatchingCommittedUserMessage(
  events: AgentChatEventEnvelope[],
  optimistic: AgentChatEventEnvelope,
): boolean {
  return events.some((event) => isMatchingOptimisticUserMessage(event, optimistic));
}

export function mergeChatHistorySnapshot(
  parsed: AgentChatEventEnvelope[],
  existing: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (!existing.length) return parsed;
  if (!parsed.length) return existing;

  const existingByKey = new Map<string, AgentChatEventEnvelope>();
  for (const entry of existing) {
    const key = chatEventDedupKey(entry);
    if (!existingByKey.has(key)) existingByKey.set(key, entry);
  }
  const parsedKeys = new Set<string>();
  const normalizedParsed = parsed.map((entry) => {
    const key = chatEventDedupKey(entry);
    parsedKeys.add(key);
    return existingByKey.get(key) ?? entry;
  });
  const lastParsedKey = chatEventDedupKey(parsed[parsed.length - 1]!);
  let overlapIndex = -1;
  for (let index = existing.length - 1; index >= 0; index -= 1) {
    if (chatEventDedupKey(existing[index]!) === lastParsedKey) {
      overlapIndex = index;
      break;
    }
  }

  const tailCandidates = overlapIndex >= 0
    ? existing.slice(overlapIndex + 1)
    : existing.filter((entry) => {
        const entryTime = Date.parse(entry.timestamp);
        const parsedTime = Date.parse(parsed[parsed.length - 1]!.timestamp);
        if (Number.isFinite(entryTime) && Number.isFinite(parsedTime)) {
          return entryTime > parsedTime;
        }
        return entry.timestamp > parsed[parsed.length - 1]!.timestamp;
      });
  const tail = tailCandidates.filter((entry) => !parsedKeys.has(chatEventDedupKey(entry)));
  const merged = tail.length ? [...normalizedParsed, ...tail] : normalizedParsed;
  if (merged.length === existing.length && merged.every((entry, index) => entry === existing[index])) {
    return existing;
  }
  return merged;
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

const INTERACTION_MODES: readonly AgentChatInteractionMode[] = ["default", "plan"];
const CLAUDE_PERMISSION_MODES: readonly AgentChatClaudePermissionMode[] = ["default", "auto", "plan", "acceptEdits", "bypassPermissions"];
const CODEX_APPROVAL_POLICIES: readonly AgentChatCodexApprovalPolicy[] = ["untrusted", "on-request", "never"];
const CODEX_SANDBOXES: readonly AgentChatCodexSandbox[] = ["read-only", "workspace-write", "danger-full-access"];
const CODEX_CONFIG_SOURCES: readonly AgentChatCodexConfigSource[] = ["flags", "config-toml"];
const OPENCODE_PERMISSION_MODES: readonly AgentChatOpenCodePermissionMode[] = ["plan", "edit", "full-auto", "config-toml"];
const DROID_PERMISSION_MODES: readonly AgentChatDroidPermissionMode[] = ["read-only", "auto-low", "auto-medium", "auto-high"];
const EXECUTION_MODES: readonly AgentChatExecutionMode[] = ["focused", "parallel", "subagents", "teams"];
const APP_CONTROL_PROVIDERS: readonly AppControlContextItem["provider"][] = ["cdp", "os-accessibility", "computer-use", "external", "coordinate-fallback"];
const MACOS_VM_PROVIDERS: readonly MacosVmContextItem["provider"][] = ["lume", "apple-virtualization-helper"];
const MACOS_VM_STATES: readonly MacosVmContextItem["state"][] = [
  "not_created",
  "creating",
  "installing",
  "stopped",
  "starting",
  "running",
  "stopping",
  "paused",
  "failed",
  "unknown",
];
const EMPTY_CHAT_EVENTS: AgentChatEventEnvelope[] = [];
const EMPTY_REASONING_TIERS: string[] = [];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function pickStringEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback;
}

function legacyPermissionModeToClaudePermissionMode(
  mode: AgentChatPermissionMode | undefined,
): AgentChatClaudePermissionMode | undefined {
  if (mode === "full-auto") return "bypassPermissions";
  if (mode === "edit") return "acceptEdits";
  if (mode === "auto") return "auto";
  if (mode === "plan") return "plan";
  if (mode === "default") return "default";
  return undefined;
}

function codexControlsFromPermissionMode(
  mode: AgentChatPermissionMode | undefined,
  fallbacks: NativeControlState,
): Pick<NativeControlState, "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource"> {
  if (mode === "config-toml") {
    return {
      codexApprovalPolicy: fallbacks.codexApprovalPolicy,
      codexSandbox: fallbacks.codexSandbox,
      codexConfigSource: "config-toml",
    };
  }
  if (mode === "full-auto") {
    return {
      codexApprovalPolicy: "never",
      codexSandbox: "danger-full-access",
      codexConfigSource: "flags",
    };
  }
  if (mode === "plan") {
    return {
      codexApprovalPolicy: "on-request",
      codexSandbox: "read-only",
      codexConfigSource: "flags",
    };
  }
  if (mode === "edit") {
    return {
      codexApprovalPolicy: "untrusted",
      codexSandbox: "workspace-write",
      codexConfigSource: "flags",
    };
  }
  return {
    codexApprovalPolicy: "on-request",
    codexSandbox: "workspace-write",
    codexConfigSource: "flags",
  };
}

function cursorConfigValuesFromSnapshot(
  snapshot: AgentChatSessionSummary["cursorModeSnapshot"] | AgentChatSession["cursorModeSnapshot"] | undefined,
): Record<string, AgentChatCursorConfigValue> {
  return Object.fromEntries(
    (snapshot?.configOptions ?? [])
      .filter((option) => option.id !== snapshot?.modeConfigId)
      .flatMap((option) => option.currentValue == null ? [] : [[option.id, option.currentValue]]),
  );
}

function normalizeCursorConfigValues(value: unknown): Record<string, AgentChatCursorConfigValue> {
  if (!isRecord(value)) return {};
  return { ...value } as Record<string, AgentChatCursorConfigValue>;
}

type LaunchConfigSessionSource = Pick<
  AgentChatSessionSummary,
  | "model"
  | "modelId"
  | "reasoningEffort"
  | "codexFastMode"
  | "executionMode"
  | "permissionMode"
  | "interactionMode"
  | "claudePermissionMode"
  | "codexApprovalPolicy"
  | "codexSandbox"
  | "codexConfigSource"
  | "opencodePermissionMode"
  | "droidPermissionMode"
  | "cursorModeSnapshot"
  | "cursorModeId"
  | "cursorConfigValues"
>;

function nativeControlsFromLaunchSource(
  source: Partial<LaunchConfigSessionSource>,
  defaults: NativeControlState,
): NativeControlState {
  const codexFallbacks = codexControlsFromPermissionMode(source.permissionMode, defaults);
  const cursorSnapshotValues = cursorConfigValuesFromSnapshot(source.cursorModeSnapshot);
  return {
    interactionMode: pickStringEnum(
      source.interactionMode,
      INTERACTION_MODES,
      source.permissionMode === "plan" ? "plan" : defaults.interactionMode,
    ),
    claudePermissionMode: pickStringEnum(
      source.claudePermissionMode,
      CLAUDE_PERMISSION_MODES,
      legacyPermissionModeToClaudePermissionMode(source.permissionMode) ?? defaults.claudePermissionMode,
    ),
    codexApprovalPolicy: pickStringEnum(
      source.codexApprovalPolicy,
      CODEX_APPROVAL_POLICIES,
      codexFallbacks.codexApprovalPolicy,
    ),
    codexSandbox: pickStringEnum(
      source.codexSandbox,
      CODEX_SANDBOXES,
      codexFallbacks.codexSandbox,
    ),
    codexConfigSource: pickStringEnum(
      source.codexConfigSource,
      CODEX_CONFIG_SOURCES,
      codexFallbacks.codexConfigSource,
    ),
    opencodePermissionMode: pickStringEnum(
      source.opencodePermissionMode,
      OPENCODE_PERMISSION_MODES,
      OPENCODE_PERMISSION_MODES.includes(source.permissionMode as AgentChatOpenCodePermissionMode)
        ? source.permissionMode as AgentChatOpenCodePermissionMode
        : defaults.opencodePermissionMode,
    ),
    droidPermissionMode: pickStringEnum(
      source.droidPermissionMode,
      DROID_PERMISSION_MODES,
      legacyPermissionModeToDroidPermissionMode(source.permissionMode) ?? defaults.droidPermissionMode,
    ),
    cursorModeId: typeof source.cursorModeId === "string"
      ? source.cursorModeId
      : source.cursorModeSnapshot?.currentModeId ?? defaults.cursorModeId,
    cursorConfigValues: {
      ...defaults.cursorConfigValues,
      ...cursorSnapshotValues,
      ...normalizeCursorConfigValues(source.cursorConfigValues),
    },
  };
}

function buildLastLaunchConfig(
  source: Partial<LaunchConfigSessionSource>,
  defaults: NativeControlState,
  updatedAt = new Date().toISOString(),
): LastLaunchConfig | null {
  const modelId = source.modelId ?? resolveRegistryModelId(source.model);
  if (!modelId) return null;
  const desc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
  return {
    version: 1,
    modelId,
    reasoningEffort: source.reasoningEffort ?? null,
    codexFastMode: modelSupportsFastMode(desc) && source.codexFastMode === true,
    executionMode: pickStringEnum(source.executionMode, EXECUTION_MODES, "focused"),
    controls: nativeControlsFromLaunchSource(source, defaults),
    updatedAt,
  };
}

function normalizeStoredLaunchConfig(
  value: unknown,
  defaults: NativeControlState,
): LastLaunchConfig | null {
  if (!isRecord(value)) return null;
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  if (!modelId) return null;
  const desc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
  const controls = nativeControlsFromLaunchSource(
    isRecord(value.controls) ? value.controls : {},
    defaults,
  );
  return {
    version: 1,
    modelId,
    reasoningEffort: typeof value.reasoningEffort === "string" && value.reasoningEffort.trim().length
      ? value.reasoningEffort.trim()
      : null,
    codexFastMode: modelSupportsFastMode(desc) && value.codexFastMode === true,
    executionMode: pickStringEnum(value.executionMode, EXECUTION_MODES, "focused"),
    controls,
    updatedAt: typeof value.updatedAt === "string" && value.updatedAt.trim().length
      ? value.updatedAt.trim()
      : new Date(0).toISOString(),
  };
}

function readLastLaunchConfig(storageKey: string, defaults: NativeControlState): LastLaunchConfig | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (raw) {
      const parsed = normalizeStoredLaunchConfig(JSON.parse(raw), defaults);
      if (parsed) return parsed;
    }
  } catch {
    // ignore
  }

  return null;
}

function readLatestLastLaunchConfig(storageKeys: string[], defaults: NativeControlState): LastLaunchConfig | null {
  let latest: LastLaunchConfig | null = null;
  for (const storageKey of storageKeys) {
    const candidate = readLastLaunchConfig(storageKey, defaults);
    if (!candidate) continue;
    if (!latest || Date.parse(candidate.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = candidate;
    }
  }
  return latest;
}

function writeLastLaunchConfig(storageKey: string, config: LastLaunchConfig): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(config));
    window.localStorage.setItem(LAST_MODEL_ID_KEY, config.modelId);
  } catch {
    // ignore
  }
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value : null;
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeComposerFrame(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!isRecord(value)) return null;
  const x = finiteNumberOrNull(value.x);
  const y = finiteNumberOrNull(value.y);
  const width = finiteNumberOrNull(value.width);
  const height = finiteNumberOrNull(value.height);
  return x == null || y == null || width == null || height == null
    ? null
    : { x, y, width, height };
}

function normalizeComposerFileAttachments(value: unknown): AgentChatFileRef[] {
  if (!Array.isArray(value)) return [];
  const out = new Map<string, AgentChatFileRef>();
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const rawType = entry.type;
    const path = nonEmptyString(entry.path);
    if (rawType === "image-url") {
      const url = nonEmptyString(entry.url);
      if (!url) continue;
      out.set(path ?? url, { path: path ?? url, type: "image-url", url });
      continue;
    }
    if (!path) continue;
    const type = rawType === "image" || rawType === "file"
      ? rawType
      : inferAttachmentType(path);
    out.set(path, { path, type });
  }
  return [...out.values()];
}

function normalizeComposerOrchestrationContextAttachment(value: unknown): AgentChatContextAttachment | null {
  if (!isRecord(value) || value.type !== "orchestration_annotation") return null;
  const item = isRecord(value.item) ? value.item : null;
  const anchor = item && isRecord(item.anchor) ? item.anchor : null;
  const runId = item ? nonEmptyString(item.runId) : null;
  const capturedAt = item ? nonEmptyString(item.capturedAt) : null;
  const anchorKind = anchor ? nonEmptyString(anchor.kind) : null;
  if (!item || !anchor || !runId || !capturedAt || !anchorKind) return null;
  const normalizedItem: OrchestrationContextItem = {
    type: "orchestration_annotation",
    runId,
    anchor: {
      kind: anchorKind as OrchestrationContextItem["anchor"]["kind"],
      ...(nonEmptyString(anchor.id) ? { id: nonEmptyString(anchor.id)! } : {}),
      preview: typeof anchor.preview === "string" ? anchor.preview : "",
      ...(nonEmptyString(anchor.href) ? { href: nonEmptyString(anchor.href)! } : {}),
      ...(nonEmptyString(anchor.sectionId) ? { sectionId: nonEmptyString(anchor.sectionId)! } : {}),
    },
    selectionExcerpt: typeof item.selectionExcerpt === "string" ? item.selectionExcerpt : "",
    comment: typeof item.comment === "string" ? item.comment : "",
    capturedAt,
  };
  return {
    type: "orchestration_annotation",
    item: normalizedItem,
    source: "manual",
    attachedAt: nullableString(value.attachedAt) ?? undefined,
  };
}

function normalizeComposerContextAttachments(value: unknown): AgentChatContextAttachment[] {
  const linear = normalizeChatContextAttachments(value);
  const annotations = Array.isArray(value)
    ? value.flatMap((entry) => {
        const normalized = normalizeComposerOrchestrationContextAttachment(entry);
        return normalized ? [normalized] : [];
      })
    : [];
  return mergeChatContextAttachments(linear, annotations);
}

function normalizeComposerIosContextItems(value: unknown): IosElementContextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || entry.kind !== "ios_element") return [];
    const id = nonEmptyString(entry.id);
    const componentId = nonEmptyString(entry.componentId);
    if (!id || !componentId) return [];
    return [{
      kind: "ios_element",
      id,
      componentId,
      sourceFile: nullableString(entry.sourceFile),
      sourceLine: finiteNumberOrNull(entry.sourceLine),
      frame: normalizeComposerFrame(entry.frame),
      metadata: isRecord(entry.metadata) ? entry.metadata : {},
      accessibilityIdentifier: nullableString(entry.accessibilityIdentifier),
      screenshotDataUrl: nullableString(entry.screenshotDataUrl) ?? undefined,
      selectedAt: nonEmptyString(entry.selectedAt) ?? new Date(0).toISOString(),
    }];
  });
}

function normalizeComposerAppControlContextItems(value: unknown): AppControlContextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || entry.kind !== "app_control_element") return [];
    const id = nonEmptyString(entry.id);
    const componentId = nonEmptyString(entry.componentId);
    if (!id || !componentId) return [];
    return [{
      kind: "app_control_element",
      id,
      appKind: "electron",
      sessionId: nullableString(entry.sessionId),
      provider: pickStringEnum(entry.provider, APP_CONTROL_PROVIDERS, "coordinate-fallback"),
      componentId,
      sourceFile: nullableString(entry.sourceFile),
      sourceLine: finiteNumberOrNull(entry.sourceLine),
      frame: normalizeComposerFrame(entry.frame),
      metadata: isRecord(entry.metadata) ? entry.metadata : {},
      screenshotDataUrl: nullableString(entry.screenshotDataUrl) ?? undefined,
      selectedAt: nonEmptyString(entry.selectedAt) ?? new Date(0).toISOString(),
    }];
  });
}

function normalizeComposerBuiltInBrowserContextItems(value: unknown): BuiltInBrowserContextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || !nonEmptyString(entry.id) || !nonEmptyString(entry.componentId)) return [];
    const normalized = normalizeBuiltInBrowserContextItem(entry);
    return normalized ? [normalized] : [];
  });
}

function normalizeComposerMacosVmContextItems(value: unknown): MacosVmContextItem[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry) || entry.kind !== "macos_vm_target") return [];
    const id = nonEmptyString(entry.id);
    const laneId = nonEmptyString(entry.laneId);
    const vmName = nonEmptyString(entry.vmName);
    if (!id || !laneId || !vmName) return [];
    return [{
      kind: "macos_vm_target",
      id,
      laneId,
      laneName: nonEmptyString(entry.laneName) ?? laneId,
      vmName,
      provider: pickStringEnum(entry.provider, MACOS_VM_PROVIDERS, "lume"),
      state: pickStringEnum(entry.state, MACOS_VM_STATES, "unknown"),
      hostLanePath: nonEmptyString(entry.hostLanePath) ?? "",
      guestLanePath: nonEmptyString(entry.guestLanePath) ?? "",
      runCommand: nonEmptyString(entry.runCommand) ?? "",
      sshCommand: nullableString(entry.sshCommand),
      vncUrl: nullableString(entry.vncUrl),
      windowTitleQuery: nonEmptyString(entry.windowTitleQuery) ?? vmName,
      screenshotDataUrl: nullableString(entry.screenshotDataUrl) ?? undefined,
      selectedAt: nonEmptyString(entry.selectedAt) ?? new Date(0).toISOString(),
      metadata: isRecord(entry.metadata) ? entry.metadata : {},
    }];
  });
}

function mergeComposerItemsById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  if (!incoming.length) return current;
  const merged = new Map<string, T>();
  for (const item of current) merged.set(item.id, item);
  for (const item of incoming) {
    if (!merged.has(item.id)) merged.set(item.id, item);
  }
  return [...merged.values()];
}

function normalizeStoredComposerDraft(
  value: unknown,
  defaults: NativeControlState,
): ComposerDraftStorageSnapshot | null {
  if (!isRecord(value)) return null;
  const modelId = typeof value.modelId === "string" ? value.modelId.trim() : "";
  const desc = modelId ? getModelById(modelId) : null;
  return {
    version: 1,
    text: typeof value.text === "string" ? value.text : "",
    modelId,
    reasoningEffort: nonEmptyString(value.reasoningEffort),
    codexFastMode: modelSupportsFastMode(desc) && value.codexFastMode === true,
    executionMode: pickStringEnum(value.executionMode, EXECUTION_MODES, "focused"),
    controls: nativeControlsFromLaunchSource(
      isRecord(value.controls) ? value.controls : {},
      defaults,
    ),
    attachments: normalizeComposerFileAttachments(value.attachments),
    contextAttachments: normalizeComposerContextAttachments(value.contextAttachments),
    iosContextItems: normalizeComposerIosContextItems(value.iosContextItems),
    appControlContextItems: normalizeComposerAppControlContextItems(value.appControlContextItems),
    builtInBrowserContextItems: normalizeComposerBuiltInBrowserContextItems(value.builtInBrowserContextItems),
    macosVmContextItems: normalizeComposerMacosVmContextItems(value.macosVmContextItems),
    draftLaunchTargetId: nonEmptyString(value.draftLaunchTargetId),
    updatedAt: nonEmptyString(value.updatedAt) ?? new Date(0).toISOString(),
  };
}

function readComposerDraftSnapshot(
  storageKey: string,
  defaults: NativeControlState,
): ComposerDraftStorageSnapshot | null {
  try {
    const raw = window.localStorage.getItem(storageKey);
    if (!raw) return null;
    return normalizeStoredComposerDraft(JSON.parse(raw), defaults);
  } catch {
    return null;
  }
}

function readLatestComposerDraftSnapshot(
  storageKeys: string[],
  defaults: NativeControlState,
): ComposerDraftStorageSnapshot | null {
  let latest: ComposerDraftStorageSnapshot | null = null;
  for (const storageKey of storageKeys) {
    const candidate = readComposerDraftSnapshot(storageKey, defaults);
    if (!candidate) continue;
    if (!latest || Date.parse(candidate.updatedAt) > Date.parse(latest.updatedAt)) {
      latest = candidate;
    }
  }
  return latest;
}

function writeComposerDraftSnapshot(storageKey: string, snapshot: ComposerDraftStorageSnapshot): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(stripComposerDraftScreenshots(snapshot)));
  } catch {
    // ignore
  }
}

function stripComposerDraftScreenshots(snapshot: ComposerDraftStorageSnapshot): ComposerDraftStorageSnapshot {
  return {
    ...snapshot,
    iosContextItems: snapshot.iosContextItems.map((item) => (
      item.screenshotDataUrl ? { ...item, screenshotDataUrl: undefined } : item
    )),
    appControlContextItems: snapshot.appControlContextItems.map((item) => (
      item.screenshotDataUrl ? { ...item, screenshotDataUrl: undefined } : item
    )),
    builtInBrowserContextItems: snapshot.builtInBrowserContextItems.map((item) => (
      item.screenshotDataUrl ? { ...item, screenshotDataUrl: null } : item
    )),
    macosVmContextItems: snapshot.macosVmContextItems.map((item) => (
      item.screenshotDataUrl ? { ...item, screenshotDataUrl: undefined } : item
    )),
  };
}

function resolveCliRegistryModelId(provider: "codex" | "claude" | "cursor" | "droid", value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  if (provider === "cursor") {
    const fullId = normalized.startsWith("cursor/") ? normalized : `cursor/${normalized}`;
    const dynamic =
      resolveModelDescriptorWithRuntimeCatalog(fullId)
      ?? getModelById(fullId)
      ?? resolveModelDescriptorForProvider(normalized.replace(/^cursor\//, ""), "cursor");
    if (dynamic && dynamic.family === "cursor") return dynamic.id;
    return null;
  }
  if (provider === "droid") {
    const fullId = normalized.startsWith("droid/") ? normalized : `droid/${normalized}`;
    const dynamic = getModelById(fullId) ?? resolveModelDescriptorForProvider(normalized.replace(/^droid\//, ""), "droid");
    if (dynamic && dynamic.family === "factory") return dynamic.id;
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

function cursorModelAllowedForDraftKind(
  descriptor: ModelDescriptor | null | undefined,
  workDraftKind: "chat" | "cli" | "chat-orchestrator",
): boolean {
  if (descriptor?.family !== "cursor") return true;
  const availability = descriptor.cursorAvailability;
  if (!availability) return false;
  if (workDraftKind === "cli") return availability.cli === true;
  return availability.sdk === true;
}

function filterCursorModelIdsForDraftKind(
  modelIds: string[],
  workDraftKind: "chat" | "cli" | "chat-orchestrator",
): string[] {
  return modelIds.filter((modelId) => {
    const descriptor = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
    return cursorModelAllowedForDraftKind(descriptor, workDraftKind);
  });
}

function chatToolTypeForProvider(provider: string | null | undefined): TerminalToolType {
  switch (provider) {
    case "codex": return "codex-chat";
    case "claude": return "claude-chat";
    case "cursor": return "cursor";
    case "droid": return "droid-chat";
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

function slugifyParallelLaneSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function parallelLaneProviderPrefix(descriptor: ModelDescriptor | null | undefined): string {
  if (!descriptor) return "model";
  if (descriptor.cliCommand === "codex" || (descriptor.isCliWrapped && descriptor.family === "openai")) return "codex";
  if (descriptor.cliCommand === "claude" || (descriptor.isCliWrapped && descriptor.family === "anthropic")) return "claude";
  if (descriptor.family === "cursor") return "cursor";
  return slugifyParallelLaneSegment(descriptor.family) || "model";
}

export function parallelLaneModelSuffix(descriptor: ModelDescriptor | null | undefined): string {
  if (!descriptor) return "model";
  const prefix = parallelLaneProviderPrefix(descriptor);
  const rawBase =
    descriptor.providerModelId?.trim()
    || descriptor.shortId?.trim()
    || descriptor.displayName?.trim()
    || descriptor.id;
  const base = slugifyParallelLaneSegment(rawBase)
    .replace(/^(claude|codex|cursor)-+/, "")
    .replace(new RegExp(`^${prefix}-+`), "");
  const candidate = [prefix, base].filter(Boolean).join("-");
  return candidate.slice(0, 40) || prefix || "model";
}

export function buildParallelLaunchPrompt(args: {
  text: string;
  attachmentCount: number;
  contextAttachmentCount?: number;
}): { sendText: string; displayText: string } {
  const trimmed = args.text.trim();
  let displayText = "";
  if (trimmed.length) {
    displayText = trimmed;
  } else if (args.attachmentCount > 0) {
    displayText = DEFAULT_PARALLEL_ATTACHMENT_REQUEST;
  } else if ((args.contextAttachmentCount ?? 0) > 0) {
    displayText = "Use the attached issue context.";
  }
  if (!displayText.length) {
    return { sendText: "", displayText: "" };
  }
  return { sendText: displayText, displayText };
}

export type ParallelLaunchCleanupIssue = {
  phase: "delete" | "refresh";
  laneId: string | null;
  error: unknown;
};

function logParallelLaunchCleanupError({ phase, laneId, error }: ParallelLaunchCleanupIssue): void {
  console.error("parallel launch cleanup failed", {
    phase,
    laneId,
    error: error instanceof Error ? error.message : String(error),
  });
}

function isMissingParallelLaunchLaneError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not found|no such lane|does not exist/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isTurnAlreadyActiveError(error: unknown): boolean {
  return /turn is already active|already active/i.test(errorMessage(error));
}

function isNoActiveTurnToSteerError(error: unknown): boolean {
  return /no active turn to steer/i.test(errorMessage(error));
}

function isCodexGoalSlashInput(value: string): boolean {
  return /^\/goal(?:\s|$)/i.test(value.trim());
}

export function formatParallelLaunchFailureMessage(args: {
  launchError: string;
  cleanupIssues: ParallelLaunchCleanupIssue[];
}): string {
  const base = args.launchError.trim() || "Parallel launch failed.";
  if (args.cleanupIssues.length === 0) return base;

  const failedDeleteLaneIds = Array.from(new Set(
    args.cleanupIssues
      .filter((issue) => issue.phase === "delete" && typeof issue.laneId === "string" && issue.laneId.trim().length > 0)
      .map((issue) => issue.laneId!.trim()),
  ));
  const refreshFailed = args.cleanupIssues.some((issue) => issue.phase === "refresh");
  const cleanupSummary = [
    failedDeleteLaneIds.length
      ? `Cleanup could not delete lane${failedDeleteLaneIds.length === 1 ? "" : "s"} ${failedDeleteLaneIds.join(", ")}`
      : null,
    refreshFailed ? "lane list refresh also failed" : null,
  ].filter((part): part is string => Boolean(part)).join("; ");

  return cleanupSummary.length
    ? `${base} ${cleanupSummary}. Check the lane list before retrying.`
    : base;
}

export async function cleanupTransientParallelLaunchLanes(args: {
  laneIds: string[];
  deleteLane: (args: { laneId: string; force?: boolean }) => Promise<void>;
  refreshLanes: () => Promise<void>;
  onCleanupError?: (issue: ParallelLaunchCleanupIssue) => void;
}): Promise<ParallelLaunchCleanupIssue[]> {
  const issues: ParallelLaunchCleanupIssue[] = [];
  if (args.laneIds.length === 0) return issues;
  for (const laneId of args.laneIds) {
    try {
      await args.deleteLane({ laneId, force: true });
    } catch (error) {
      if (isMissingParallelLaunchLaneError(error)) continue;
      const issue: ParallelLaunchCleanupIssue = { phase: "delete", laneId, error };
      issues.push(issue);
      args.onCleanupError?.(issue);
    }
  }
  try {
    await args.refreshLanes();
  } catch (error) {
    const issue: ParallelLaunchCleanupIssue = { phase: "refresh", laneId: null, error };
    issues.push(issue);
    args.onCleanupError?.(issue);
  }
  return issues;
}

function buildParallelLaunchState(args: {
  parentLaneId: string;
  createdLaneIds: string[];
  sentLaneIds?: string[];
  status: AgentChatParallelLaunchState["status"];
  lastError?: string | null;
}): AgentChatParallelLaunchState {
  const createdLaneIds = Array.from(new Set(args.createdLaneIds.map((laneId) => laneId.trim()).filter(Boolean)));
  const sentLaneIds = Array.from(new Set(
    (args.sentLaneIds ?? [])
      .map((laneId) => laneId.trim())
      .filter((laneId) => createdLaneIds.includes(laneId)),
  ));
  return {
    parentLaneId: args.parentLaneId.trim(),
    createdLaneIds,
    sentLaneIds,
    status: args.status,
    updatedAt: new Date().toISOString(),
    lastError: args.lastError?.trim() || null,
  };
}

function isCompletedParallelLaunchState(state: AgentChatParallelLaunchState): boolean {
  return state.status === "completed" || (
    state.createdLaneIds.length > 0 && state.sentLaneIds.length >= state.createdLaneIds.length
  );
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

function orderAvailableModelIds(ids: Iterable<string>): string[] {
  const available = new Set(ids);
  const ordered = MODEL_REGISTRY
    .filter((model) => !model.deprecated && available.has(model.id))
    .map((model) => model.id);
  const extra = [...available].filter((modelId) => !ordered.includes(modelId));
  extra.sort((left, right) => {
    const leftLabel = getModelById(left)?.displayName ?? left;
    const rightLabel = getModelById(right)?.displayName ?? right;
    return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
  });
  return [...ordered, ...extra];
}

function completionBadgeClass(status: NonNullable<AgentChatSessionSummary["completion"]>["status"]): string {
  switch (status) {
    case "completed": return "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300";
    case "blocked": return "border-red-400/20 bg-red-400/[0.08] text-red-300";
    default: return "border-amber-400/20 bg-amber-400/[0.08] text-amber-300";
  }
}

type ChatCompanionUiState = {
  chatActionsOpen: boolean;
  chatActionsTab: ChatActionsTab;
  iosSimulatorOpen: boolean;
  appControlOpen: boolean;
  terminalDrawerOpen: boolean;
};

const DEFAULT_CHAT_COMPANION_UI_STATE: ChatCompanionUiState = {
  chatActionsOpen: false,
  chatActionsTab: "agents",
  iosSimulatorOpen: false,
  appControlOpen: false,
  terminalDrawerOpen: false,
};

function parseChatActionsTab(value: unknown): ChatActionsTab {
  if (value === "agents" || value === "proof" || value === "handoff") return value;
  return "agents";
}

const chatCompanionUiStateByKey = new Map<string, ChatCompanionUiState>();

function chatCompanionUiStorageKey(key: string): string {
  return `ade.chat.companionUiState.${key}`;
}

function readChatCompanionUiState(key: string): ChatCompanionUiState {
  const cached = chatCompanionUiStateByKey.get(key);
  if (cached) return cached;
  try {
    const raw = window.sessionStorage.getItem(chatCompanionUiStorageKey(key));
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<ChatCompanionUiState> & { proofDrawerOpen?: boolean };
      const legacyProofOpen = parsed.proofDrawerOpen === true;
      const state = {
        chatActionsOpen: parsed.chatActionsOpen === true || legacyProofOpen,
        chatActionsTab: legacyProofOpen && parsed.chatActionsTab == null
          ? "proof"
          : parseChatActionsTab(parsed.chatActionsTab),
        iosSimulatorOpen: parsed.iosSimulatorOpen === true,
        appControlOpen: parsed.appControlOpen === true,
        terminalDrawerOpen: parsed.terminalDrawerOpen === true,
      };
      chatCompanionUiStateByKey.set(key, state);
      return state;
    }
  } catch {
    // Session storage is best-effort UI state only.
  }
  return DEFAULT_CHAT_COMPANION_UI_STATE;
}

function writeChatCompanionUiState(key: string, state: ChatCompanionUiState): void {
  chatCompanionUiStateByKey.set(key, state);
  try {
    window.sessionStorage.setItem(chatCompanionUiStorageKey(key), JSON.stringify(state));
  } catch {
    // Session storage is best-effort UI state only.
  }
}

function isLikelyMacRenderer(): boolean {
  if (typeof navigator === "undefined") return false;
  return /\bMac\b/i.test(navigator.platform) || /\bMac OS X\b/i.test(navigator.userAgent);
}

export function AgentChatPane({
  laneId,
  laneLabel,
  initialSessionId,
  initialSessionSummary,
  lockSessionId,
  hideSessionTabs = false,
  hideNativeControls = false,
  hideWorkspaceChrome = false,
  hideLaneToolDrawers = false,
  forceNewSession = false,
  forceDraftMode = false,
  availableModelIdsOverride,
  modelSelectionLocked = false,
  permissionModeLocked = false,
  presentation,
  embeddedWorkLayout = false,
  suppressDraftLaunchNavigation = false,
  layoutVariant = "standard",
  isTileActive = true,
  isTileVisible = isTileActive,
  shouldAutofocusComposer = false,
  draftContextTargetId = null,
  initialLinearIssueContext = null,
  initialLinearIssueContextSource = "lane_link",
  initialModelId = null,
  onInitialLinearIssueContextConsumed,
  onSessionCreated,
  workDraftKind = "chat",
  onLaunchCliSession,
  onOpenShellSession,
  availableLanes,
  onLaneChange,
}: {
  laneId: string | null;
  laneLabel?: string | null;
  initialSessionId?: string | null;
  initialSessionSummary?: AgentChatSessionSummary | null;
  lockSessionId?: string | null;
  hideSessionTabs?: boolean;
  hideNativeControls?: boolean;
  hideWorkspaceChrome?: boolean;
  /** Work owns these lane-scoped drawers; proof remains chat-scoped here. */
  hideLaneToolDrawers?: boolean;
  forceNewSession?: boolean;
  forceDraftMode?: boolean;
  availableModelIdsOverride?: string[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
  presentation?: ChatSurfacePresentation;
  /** Work tab draft: flatter shell, no duplicate header chrome above the composer. */
  embeddedWorkLayout?: boolean;
  /** Embedded Lanes work pane owns selection in place; don't route after draft launch. */
  suppressDraftLaunchNavigation?: boolean;
  layoutVariant?: "standard" | "grid-tile";
  isTileActive?: boolean;
  /** Visible grid tiles hydrate transcripts even when they are not the focused tile. */
  isTileVisible?: boolean;
  shouldAutofocusComposer?: boolean;
  /** Stable Work-sidebar target id for an unsaved draft composer. */
  draftContextTargetId?: string | null;
  initialLinearIssueContext?: LaneLinearIssue | null;
  initialLinearIssueContextSource?: "manual" | "lane_link";
  initialModelId?: string | null;
  onInitialLinearIssueContextConsumed?: () => void;
  onSessionCreated?: (session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => void | Promise<void>;
  workDraftKind?: "chat" | "cli" | "chat-orchestrator";
  onLaunchCliSession?: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onOpenShellSession?: (laneId: string) => void | Promise<void>;
  /** Available lanes for the lane selector in empty state (full `LaneSummary` includes `branchRef` for branch sublines in the menu). */
  availableLanes?: Array<{ id: string; name: string; color?: string | null; branchRef?: string | null; laneType?: string | null }>;
  /** Callback when lane selection changes in empty state */
  onLaneChange?: (laneId: string) => void;
}) {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectTransition = useAppStore((s) => s.projectTransition);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  const agentTurnCompletionSound = useAppStore((s) => s.agentTurnCompletionSound);
  const agentTurnCompletionSoundVolume = useAppStore((s) => s.agentTurnCompletionSoundVolume);
  const agentTurnCompletionSoundQuietWhenFocused = useAppStore((s) => s.agentTurnCompletionSoundQuietWhenFocused);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  const chatChromeTint = useAppStore((s) => s.chatChromeTint);
  const chatShellGeometry = useAppStore((s) => s.chatShellGeometry);
  const launchPromptClipboardEnabled = useAppStore((s) => s.launchPromptClipboardEnabled);
  const launchPromptClipboardNoticeEnabled = useAppStore((s) => s.launchPromptClipboardNoticeEnabled);
  const chatAppearanceRootStyle = useMemo(
    () => buildChatAppearanceRootStyle({ chatFontSizePx, transcriptDensity: chatTranscriptDensity }),
    [chatFontSizePx, chatTranscriptDensity],
  );
  const lanes = useAppStore((s) => s.lanes);
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);
  const openLinearSettings = useCallback(() => {
    navigate("/settings?tab=integrations&integration=linear");
  }, [navigate]);
  const openLaunchPromptClipboardSettings = useCallback(() => {
    navigate("/settings?tab=appearance#chat-launch-clipboard");
  }, [navigate]);
  const copyPromptForLaunch = useCallback(async (promptText: string) => {
    if (!launchPromptClipboardEnabled) return;
    await copyLaunchPromptToClipboard(promptText);
  }, [launchPromptClipboardEnabled]);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const setLaneWorkViewState = useAppStore((s) => s.setLaneWorkViewState);
  const refreshLanesStore = useAppStore((s) => s.refreshLanes);
  const laneAccentColor = useAppStore((s) => {
    if (!laneId) return null;
    return s.lanes.find((l) => l.id === laneId)?.color ?? null;
  });
  const pinnedLinearIssue = useAppStore((s) => {
    if (!laneId) return null;
    return s.lanes.find((l) => l.id === laneId)?.linearIssue ?? null;
  });
  const lockedSingleSessionMode = Boolean(lockSessionId && hideSessionTabs);
  const forceDraft = forceDraftMode || forceNewSession;
  const preferDraftStart = !lockSessionId && !initialSessionId && !forceNewSession;
  const surfaceProfile: ChatSurfaceProfile = presentation?.profile ?? "standard";
  const isPersistentIdentitySurface = surfaceProfile === "persistent_identity";
  const showWorkspaceChrome = !hideWorkspaceChrome;
  const modelSwitchPolicy = presentation?.modelSwitchPolicy ?? "same-family-after-launch";
  const workDraftStorageKind = normalizeWorkDraftStorageKind(workDraftKind);
  const initialNativeControls = useMemo(() => defaultNativeControls(surfaceProfile), [surfaceProfile]);
  const lastLaunchConfigStorageKeys = useMemo(() => launchConfigStorageKeys({
    projectRoot,
    laneId,
    surfaceProfile,
    workDraftKind: workDraftStorageKind,
  }), [laneId, projectRoot, surfaceProfile, workDraftStorageKind]);
  const lastLaunchConfigStorageKey = lastLaunchConfigStorageKeys[0]!;
  const draftLaunchConfigScopeKey = useMemo(
    () => `${projectRoot ?? "project"}:${laneId ?? "no-lane"}:${surfaceProfile}:${workDraftStorageKind}`,
    [laneId, projectRoot, surfaceProfile, workDraftStorageKind],
  );
  const draftLaunchJobsScopeKey = useMemo(
    () => [
      "draft-launch-jobs",
      projectRoot?.trim() || "project",
      laneId ?? "no-lane",
      surfaceProfile,
      workDraftStorageKind,
    ].map(encodeURIComponent).join(":"),
    [laneId, projectRoot, surfaceProfile, workDraftStorageKind],
  );
  const draftLaunchJobs = useAppStore((s) => s.draftLaunchJobsByScope[draftLaunchJobsScopeKey] ?? EMPTY_DRAFT_LAUNCH_JOBS);
  const setDraftLaunchJobsInStore = useAppStore((s) => s.setDraftLaunchJobs);
  const setDraftLaunchJobs = useCallback((
    next: DraftLaunchJob[] | ((prev: DraftLaunchJob[]) => DraftLaunchJob[]),
  ) => {
    setDraftLaunchJobsInStore(draftLaunchJobsScopeKey, next);
  }, [draftLaunchJobsScopeKey, setDraftLaunchJobsInStore]);
  const hasActiveDraftLaunchJobs = useMemo(
    () => draftLaunchJobs.some((job) => !isDraftLaunchJobTerminal(job.status)),
    [draftLaunchJobs],
  );
  const [draftLaunchJobNowMs, setDraftLaunchJobNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (!hasActiveDraftLaunchJobs) return;
    setDraftLaunchJobNowMs(Date.now());
    const intervalId = window.setInterval(() => {
      setDraftLaunchJobNowMs(Date.now());
    }, 15 * 1000);
    return () => window.clearInterval(intervalId);
  }, [hasActiveDraftLaunchJobs]);
  const initialCompanionStateKey = lockSessionId ?? initialSessionId ?? (laneId ? `draft:${laneId}` : "draft");
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<AgentChatSessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(lockSessionId ?? initialSessionId ?? null);
  const [draftLaunchTargetId, setDraftLaunchTargetId] = useState<string | null>(null);
  const isWorkCliLaunchDraft =
    !lockSessionId
    && !initialSessionId
    && forceDraft
    && embeddedWorkLayout
    && workDraftKind === "cli"
    && selectedSessionId == null
    && Boolean(onLaunchCliSession);
  const [eventsBySession, setEventsBySession] = useState<Record<string, AgentChatEventEnvelope[]>>({});
  const [turnActiveBySession, setTurnActiveBySession] = useState<Record<string, boolean>>({});
  const [pendingInputsBySession, setPendingInputsBySession] = useState<Record<string, DerivedPendingInput[]>>({});
  const [codexGoalPendingBySession, setCodexGoalPendingBySession] = useState<Record<string, boolean>>({});
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<Set<string>>(new Set());
  const [pendingSteersBySession, setPendingSteersBySession] = useState<Record<string, PendingSteerEntry[]>>({});
  const [modelId, setModelId] = useState<string>("");
  const [runtimeCatalogVersion, setRuntimeCatalogVersion] = useState(0);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [codexFastMode, setCodexFastMode] = useState(false);
  const [executionMode, setExecutionMode] = useState<AgentChatExecutionMode>("focused");
  const [interactionMode, setInteractionMode] = useState<AgentChatInteractionMode>(initialNativeControls.interactionMode);
  // Seed availableModelIds, aiStatus, and providerConnections synchronously
  // from the cached AI status (if any). This avoids a "not configured" flash
  // in the model picker every time a chat pane mounts: the previously-known
  // configured set is shown immediately, and `refreshAvailableModels` below
  // re-verifies asynchronously and corrects any stale entries. We only block
  // sends when the *fresh* status confirms the provider is unauthenticated;
  // the seeded value is purely cosmetic for the picker's "Ready / not
  // configured" labels.
  const seedAiStatus = useMemo<AiStatusSnapshot | null>(
    () => peekAiStatusCached(projectRoot),
    // projectRoot is stable for the lifetime of a project session — recompute
    // only when the user actually switches projects. We intentionally do not
    // depend on cache mutations; refreshAvailableModels overrides state once
    // the async re-check resolves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [projectRoot],
  );
  const [availableModelIds, setAvailableModelIds] = useState<string[]>(() =>
    seedAiStatus ? deriveConfiguredModelIds(seedAiStatus, { includeDroid: true }) : [],
  );
  const availableModelsRefreshSeqRef = useRef(0);
  const [claudePermissionMode, setClaudePermissionMode] = useState<AgentChatClaudePermissionMode>(initialNativeControls.claudePermissionMode);
  const [codexApprovalPolicy, setCodexApprovalPolicy] = useState<AgentChatCodexApprovalPolicy>(initialNativeControls.codexApprovalPolicy);
  const [codexSandbox, setCodexSandbox] = useState<AgentChatCodexSandbox>(initialNativeControls.codexSandbox);
  const [codexConfigSource, setCodexConfigSource] = useState<AgentChatCodexConfigSource>(initialNativeControls.codexConfigSource);
  const [opencodePermissionMode, setOpenCodePermissionMode] = useState<AgentChatOpenCodePermissionMode>(initialNativeControls.opencodePermissionMode);
  const [droidPermissionMode, setDroidPermissionMode] = useState<AgentChatDroidPermissionMode>(initialNativeControls.droidPermissionMode);
  const prevModelDescRef = useRef<ModelDescriptor | null | undefined>(undefined);
  const [cursorModeId, setCursorModeId] = useState<string | null>(initialNativeControls.cursorModeId);
  const [cursorConfigValues, setCursorConfigValues] = useState<Record<string, AgentChatCursorConfigValue>>(initialNativeControls.cursorConfigValues);
  const [aiStatus, setAiStatus] = useState<AiStatusSnapshot | null>(seedAiStatus);
  const [providerConnections, setProviderConnections] = useState<{
    claude: AiProviderConnectionStatus | null;
    codex: AiProviderConnectionStatus | null;
    cursor: AiProviderConnectionStatus | null;
    droid: AiProviderConnectionStatus | null;
  } | null>(() =>
    seedAiStatus
      ? {
          claude: seedAiStatus.providerConnections?.claude ?? null,
          codex: seedAiStatus.providerConnections?.codex ?? null,
          cursor: seedAiStatus.providerConnections?.cursor ?? null,
          droid: seedAiStatus.providerConnections?.droid ?? null,
        }
      : null,
  );
  const [attachments, setAttachments] = useState<AgentChatFileRef[]>([]);
  const [contextAttachments, setContextAttachments] = useState<AgentChatContextAttachment[]>([]);
  const [sdkSlashCommands, setSdkSlashCommands] = useState<import("../../../shared/types").AgentChatSlashCommand[]>([]);
  const [sendOnEnter, setSendOnEnter] = useState(true);
  const [draft, setDraft] = useState("");
  const draftsPerSessionRef = useRef<Map<string, string>>(new Map());
  const composerDraftWriteTimerRef = useRef<number | null>(null);
  const pendingComposerDraftWriteRef = useRef<{
    storageKey: string;
    snapshot: ComposerDraftStorageSnapshot;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [shellLaunchBusy, setShellLaunchBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingChatSessionId, setDeletingChatSessionId] = useState<string | null>(null);
  const [computerUseSnapshot, setComputerUseSnapshot] = useState<ComputerUseOwnerSnapshot | null>(null);
  const [chatActionsOpen, setChatActionsOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).chatActionsOpen,
  );
  const [chatActionsTab, setChatActionsTab] = useState<ChatActionsTab>(
    () => readChatCompanionUiState(initialCompanionStateKey).chatActionsTab,
  );
  const [iosSimulatorOpen, setIosSimulatorOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).iosSimulatorOpen,
  );
  const [iosSimulatorDrawerModeRequest, setIosSimulatorDrawerModeRequest] = useState<{ mode: IosSimulatorDrawerMode; nonce: number } | null>(null);
  const [iosSimulatorAvailable, setIosSimulatorAvailable] = useState(isLikelyMacRenderer);
  const [cursorCloudPaneOpen, setCursorCloudPaneOpen] = useState(false);
  // Subagent drill-in: when set, the chat surface renders the named subagent's
  // transcript instead of the parent stream and the composer is disabled.
  const [subagentView, setSubagentView] = useState<{
    taskId: string;
    agentId: string | null;
    agentType: string | null;
    status: "running" | "completed" | "failed" | "stopped";
    background: boolean;
  } | null>(null);
  const [rewindConfirmDialog, setRewindConfirmDialog] = useState<RewindFilesConfirmDialogState | null>(null);
  const [cursorCloudLaunchModeOpen, setCursorCloudLaunchModeOpen] = useState(false);
  const cursorCloudPanelRef = useRef<ChatCursorCloudPanelHandle | null>(null);
  const cursorCloudInlineLaunchRef = useRef<CursorCloudInlineLaunchHandle | null>(null);
  const rewindConfirmResolveRef = useRef<((confirmed: boolean) => void) | null>(null);
  const [laneGitRemote, setLaneGitRemote] = useState<string | null>(null);
  const [laneGitBranch, setLaneGitBranch] = useState<string | null>(null);
  const [iosElementContextItems, setIosElementContextItems] = useState<IosElementContextItem[]>([]);
  const [appControlOpen, setAppControlOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).appControlOpen,
  );
  const [appControlAvailable, setAppControlAvailable] = useState(false);
  const [appControlContextItems, setAppControlContextItems] = useState<AppControlContextItem[]>([]);
  const [builtInBrowserContextItems, setBuiltInBrowserContextItems] = useState<BuiltInBrowserContextItem[]>([]);
  const [macosVmContextItems, setMacosVmContextItems] = useState<MacosVmContextItem[]>([]);
  const latestAttachmentRef = useRef<{ path: string; type: AgentChatFileRef["type"]; addedAt: number } | null>(null);
  const linkedIosAttachmentPathsRef = useRef<Set<string>>(new Set());
  const linkedAppControlAttachmentPathsRef = useRef<Set<string>>(new Set());
  const linkedBuiltInBrowserAttachmentPathsRef = useRef<Set<string>>(new Set());
  const [terminalDrawerOpen, setTerminalDrawerOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).terminalDrawerOpen,
  );
  const [terminalRevealRequest, setTerminalRevealRequest] = useState<{
    terminalId: string;
    ptyId: string;
    label: string;
    nonce: number;
  } | null>(null);
  const terminalRevealNonceRef = useRef(0);
  const [rightPaneSplit, setRightPaneSplit] = useState<number>(() => {
    try {
      const raw = window.sessionStorage.getItem("ade.chat.rightPaneSplit");
      const n = raw == null ? NaN : Number(raw);
      if (Number.isFinite(n) && n >= 20 && n <= 80) return n;
    } catch {
      // sessionStorage unavailable — fall through to default
    }
    return 50;
  });
  useEffect(() => {
    try {
      window.sessionStorage.setItem("ade.chat.rightPaneSplit", String(rightPaneSplit));
    } catch {
      // best-effort persistence only
    }
  }, [rightPaneSplit]);
  const handleRightPaneDividerDown = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const container = event.currentTarget.parentElement;
    if (!container) return;
    const totalWidth = container.getBoundingClientRect().width;
    if (totalWidth <= 0) return;
    const startX = event.clientX;
    const startSplit = rightPaneSplit;
    const onMove = (ev: MouseEvent) => {
      const deltaPct = ((ev.clientX - startX) / totalWidth) * 100;
      const next = Math.max(20, Math.min(80, startSplit - deltaPct));
      setRightPaneSplit(next);
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [rightPaneSplit]);
  const companionStateKey = selectedSessionId ?? (laneId ? `draft:${laneId}` : "draft");
  const composerDraftStorageKeyValues = useMemo(() => composerDraftStorageKeys({
    projectRoot,
    companionStateKey,
    surfaceProfile,
    workDraftKind: workDraftStorageKind,
  }), [companionStateKey, projectRoot, surfaceProfile, workDraftStorageKind]);
  const composerDraftStorageKeyValue = composerDraftStorageKeyValues[0]!;
  const companionHydrationKeyRef = useRef<string | null>(initialCompanionStateKey);
  const composerDraftHydratingRef = useRef(false);
  const [sessionDelta, setSessionDelta] = useState<{ insertions: number; deletions: number } | null>(null);
  const [sessionMutationKind, setSessionMutationKind] = useState<"model" | "permission" | "computer-use" | null>(null);
  const [promptSuggestion, setPromptSuggestion] = useState<string | null>(null);
  const [optimisticOutgoingMessage, setOptimisticOutgoingMessage] = useState<{
    sessionId: string;
    envelope: AgentChatEventEnvelope;
  } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffModelId, setHandoffModelId] = useState("");
  const [handoffReasoningEffort, setHandoffReasoningEffort] = useState<string | null>(null);
  const [handoffCodexFastMode, setHandoffCodexFastMode] = useState(false);
  const [handoffClaudePermissionMode, setHandoffClaudePermissionMode] = useState<AgentChatClaudePermissionMode>(
    initialNativeControls.claudePermissionMode,
  );
  const [handoffCodexApprovalPolicy, setHandoffCodexApprovalPolicy] = useState<AgentChatCodexApprovalPolicy>(
    initialNativeControls.codexApprovalPolicy,
  );
  const [handoffCodexSandbox, setHandoffCodexSandbox] = useState<AgentChatCodexSandbox>(initialNativeControls.codexSandbox);
  const [handoffCodexConfigSource, setHandoffCodexConfigSource] = useState<AgentChatCodexConfigSource>(
    initialNativeControls.codexConfigSource,
  );
  const [handoffOpenCodePermissionMode, setHandoffOpenCodePermissionMode] = useState<AgentChatOpenCodePermissionMode>(
    initialNativeControls.opencodePermissionMode,
  );
  const [handoffDroidPermissionMode, setHandoffDroidPermissionMode] = useState<AgentChatDroidPermissionMode>(
    initialNativeControls.droidPermissionMode,
  );
  const [handoffCursorModeId, setHandoffCursorModeId] = useState<string | null>(initialNativeControls.cursorModeId);
  const [handoffCursorConfigValues, setHandoffCursorConfigValues] = useState<Record<string, AgentChatCursorConfigValue>>(
    () => ({ ...initialNativeControls.cursorConfigValues }),
  );
  const [parallelChatMode, setParallelChatMode] = useState(false);
  const [parallelModelSlots, setParallelModelSlots] = useState<ParallelModelRowState[]>([]);
  const [parallelConfiguringIndex, setParallelConfiguringIndex] = useState<number | null>(null);

  useEffect(() => {
    if (workDraftKind === "cli" && parallelChatMode) {
      setParallelChatMode(false);
      setParallelModelSlots([]);
      setParallelConfiguringIndex(null);
    }
  }, [parallelChatMode, workDraftKind]);
  const [parallelLaunchBusy, setParallelLaunchBusy] = useState(false);
  const [parallelLaunchStatus, setParallelLaunchStatus] = useState<string | null>(null);
  const shellRef = useRef<HTMLElement | null>(null);
  const composerMaxHeightPx = layoutVariant === "grid-tile" ? 144 : null;
  const sessionsRef = useRef<AgentChatSessionSummary[]>(sessions);
  const completionSoundPrevTurnActiveRef = useRef(false);
  const completionSoundArmedRef = useRef(true);
  const projectTransitionBlocksChat = projectTransition != null;

  const appliedInitialSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());
  const draftSelectionLockedRef = useRef(false);
  const optimisticSessionIdsRef = useRef<Set<string>>(new Set());
  const pendingSelectedSessionIdRef = useRef<string | null>(null);
  const submitInFlightRef = useRef(false);
  const latestForegroundDraftLaunchJobIdRef = useRef<string | null>(null);
  const draftLaunchInFlightKeysRef = useRef<Set<string>>(new Set());
  const createSessionPromiseRef = useRef<Promise<string | null> | null>(null);
  const pendingNativeControlUpdateRef = useRef<{
    sessionId: string;
    updateId: number;
    promise: Promise<void>;
  } | null>(null);
  const nativeControlUpdateCounterRef = useRef(0);
  const reasoningEffortUpdateCounterRef = useRef(0);
  const codexFastModeUpdateCounterRef = useRef(0);
  const pendingCodexFastModeUpdateRef = useRef<{ sessionId: string; updateId: number; promise: Promise<void> } | null>(null);
  const pendingEventQueueRef = useRef<AgentChatEventEnvelope[]>([]);
  const eventsBySessionRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const eventFlushTimerRef = useRef<number | null>(null);
  const refreshSessionsTimerRef = useRef<number | null>(null);
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const computerUseSnapshotInFlightRef = useRef<{ sessionId: string; promise: Promise<void> } | null>(null);
  const lastComputerUseSnapshotRef = useRef<{ sessionId: string; fetchedAt: number } | null>(null);
  const knownSessionIdsRef = useRef<Set<string>>(new Set());
  const seededInitialSummaryRef = useRef(false);
  const localTouchBySessionRef = useRef<Map<string, string>>(new Map());
  const cursorWarmupKeyRef = useRef<string | null>(null);
  const draftLaunchConfigHydratedRef = useRef<string | null>(null);
  const draftLaunchConfigTouchedKeyRef = useRef<string | null>(null);
  const recoveredParallelLaunchKeyRef = useRef<string | null>(null);
  const paneMountedRef = useRef(true);
  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.sessionId === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId]
  );
  const effectiveIosSimulatorOpen = !hideLaneToolDrawers && iosSimulatorOpen;
  const effectiveAppControlOpen = !hideLaneToolDrawers && appControlOpen;
  const laneToolsVisible = Boolean(showWorkspaceChrome && !hideLaneToolDrawers && laneId);
  const chatTerminalVisible = Boolean(showWorkspaceChrome && laneId);
  const laneDisplayLabel = useMemo(() => {
    const normalized = laneLabel?.trim();
    return normalized?.length ? normalized : laneId;
  }, [laneId, laneLabel]);
  const selectedSessionModelId = useMemo(() => {
    if (!selectedSession) return null;
    return selectedSession.modelId ?? resolveRegistryModelId(selectedSession.model);
  }, [selectedSession]);
  useEffect(() => {
    const api = window.ade?.iosSimulator;
    if (!api?.getStatus) return;
    if (!effectiveIosSimulatorOpen || !isTileActive) return;
    let cancelled = false;
    void api.getStatus()
      .then((status) => {
        if (cancelled) return;
        setIosSimulatorAvailable(status.platform === "darwin");
      })
      .catch(() => {
        if (cancelled) return;
        setIosSimulatorAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveIosSimulatorOpen, isTileActive]);

  useEffect(() => {
    const api = window.ade?.appControl;
    if (!api?.getStatus) return;
    if (!laneToolsVisible) return;
    if (isRemoteProject && !effectiveAppControlOpen) return;
    let cancelled = false;
    void api.getStatus()
      .then((status) => {
        if (cancelled) return;
        setAppControlAvailable(Boolean(status.supported));
      })
      .catch(() => {
        if (cancelled) return;
        setAppControlAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [effectiveAppControlOpen, isRemoteProject, laneToolsVisible]);

  useEffect(() => {
    companionHydrationKeyRef.current = companionStateKey;
    const saved = readChatCompanionUiState(companionStateKey);
    setChatActionsOpen(saved.chatActionsOpen);
    setChatActionsTab(saved.chatActionsTab);
    setIosSimulatorOpen(saved.iosSimulatorOpen);
    setAppControlOpen(saved.appControlOpen);
    setTerminalDrawerOpen(saved.terminalDrawerOpen);
  }, [companionStateKey]);

  useEffect(() => {
    if (companionHydrationKeyRef.current === companionStateKey) {
      companionHydrationKeyRef.current = null;
      return;
    }
    writeChatCompanionUiState(companionStateKey, {
      chatActionsOpen,
      chatActionsTab,
      iosSimulatorOpen,
      appControlOpen,
      terminalDrawerOpen,
    });
  }, [appControlOpen, chatActionsOpen, chatActionsTab, companionStateKey, iosSimulatorOpen, terminalDrawerOpen]);

  const removeIosElementContext = useCallback((id: string) => {
    let linkedAttachmentPath: string | null = null;
    setIosElementContextItems((current) => {
      const item = current.find((entry) => entry.id === id);
      linkedAttachmentPath = item ? getIosContextAttachmentPath(item) : null;
      return current.filter((entry) => entry.id !== id);
    });
    if (linkedAttachmentPath) {
      linkedIosAttachmentPathsRef.current.delete(linkedAttachmentPath);
      setAttachments((current) => current.filter((entry) => entry.path !== linkedAttachmentPath));
    }
  }, []);
  const removeAppControlContext = useCallback((id: string) => {
    let linkedAttachmentPath: string | null = null;
    setAppControlContextItems((current) => {
      const item = current.find((entry) => entry.id === id);
      linkedAttachmentPath = item ? getAppControlContextAttachmentPath(item) : null;
      return current.filter((entry) => entry.id !== id);
    });
    if (linkedAttachmentPath) {
      linkedAppControlAttachmentPathsRef.current.delete(linkedAttachmentPath);
      setAttachments((current) => current.filter((entry) => entry.path !== linkedAttachmentPath));
    }
  }, []);
  const removeBuiltInBrowserContext = useCallback((id: string) => {
    let linkedAttachmentPath: string | null = null;
    setBuiltInBrowserContextItems((current) => {
      const item = current.find((entry) => entry.id === id);
      linkedAttachmentPath = item ? getBuiltInBrowserContextAttachmentPath(item) : null;
      return current.filter((entry) => entry.id !== id);
    });
    if (linkedAttachmentPath) {
      linkedBuiltInBrowserAttachmentPathsRef.current.delete(linkedAttachmentPath);
      setAttachments((current) => current.filter((entry) => entry.path !== linkedAttachmentPath));
    }
  }, []);
  const removeMacosVmContext = useCallback((id: string) => {
    setMacosVmContextItems((current) => current.filter((entry) => entry.id !== id));
  }, []);
  const updateComposerDraft = useCallback((value: string) => {
    setDraft(value);
    draftsPerSessionRef.current.set(companionStateKey, value);
    if (value.length > 0) setPromptSuggestion(null);
  }, [companionStateKey]);
  const insertComposerDraft = useCallback((value: string) => {
    setDraft((current) => {
      const next = current.trim().length ? `${current.trimEnd()}\n\n${value}` : value;
      draftsPerSessionRef.current.set(companionStateKey, next);
      return next;
    });
    setPromptSuggestion(null);
  }, [companionStateKey]);

  const iosSimulatorProjectRoot = useMemo(() => {
    const scopedLaneId = selectedSession?.laneId ?? laneId;
    if (!scopedLaneId) return projectRoot;
    const lane = lanes.find((entry) => entry.id === scopedLaneId);
    return lane?.worktreePath ?? projectRoot;
  }, [laneId, lanes, projectRoot, selectedSession?.laneId]);
  const selectedEvents = selectedSessionId ? eventsBySession[selectedSessionId] ?? EMPTY_CHAT_EVENTS : EMPTY_CHAT_EVENTS;
  const optimisticOutgoingMessageRef = useRef<typeof optimisticOutgoingMessage>(null);
  const selectedEventsForDisplay = useMemo(() => {
    const shouldRenderOptimistic =
      optimisticOutgoingMessage
      && optimisticOutgoingMessage.sessionId === selectedSessionId
      && !hasMatchingCommittedUserMessage(selectedEvents, optimisticOutgoingMessage.envelope);
    const baseEvents = shouldRenderOptimistic
      ? [...selectedEvents, optimisticOutgoingMessage.envelope]
      : selectedEvents;
    const displayEvents = baseEvents.filter((envelope) => !envelope.event.type.startsWith("subagent."));
    const promotedTurnId = selectedSession?.cursorPromotedTurnId;
    const cloudAgentId = selectedSession?.cursorCloudAgentId;
    if (!promotedTurnId || !cloudAgentId) return displayEvents;
    if (displayEvents.some((env) => env.event.type === "system_notice" && env.event.noticeKind === "info" && env.event.message === "Promoted to Cursor Cloud")) {
      return displayEvents;
    }
    let insertAt = displayEvents.length;
    for (let i = 0; i < displayEvents.length; i += 1) {
      const evt = displayEvents[i]?.event;
      const turnId = evt && "turnId" in evt ? (evt as { turnId?: string }).turnId : undefined;
      if (turnId === promotedTurnId) {
        insertAt = i;
        break;
      }
    }
    const refEnvelope = displayEvents[insertAt] ?? displayEvents[displayEvents.length - 1];
    const synthetic: AgentChatEventEnvelope = {
      sessionId: selectedSessionId ?? "",
      timestamp: refEnvelope?.timestamp ?? new Date().toISOString(),
      event: {
        type: "system_notice",
        noticeKind: "info",
        message: "Promoted to Cursor Cloud",
        detail: cloudAgentId,
        turnId: promotedTurnId,
      },
    };
    return [...displayEvents.slice(0, insertAt), synthetic, ...displayEvents.slice(insertAt)];
  }, [optimisticOutgoingMessage, selectedEvents, selectedSession?.cursorCloudAgentId, selectedSession?.cursorPromotedTurnId, selectedSessionId]);
  const selectedCodexGoal = useMemo<CodexThreadGoal | null>(() => {
    let goalFromEvents: CodexThreadGoal | null = null;
    let sawGoalEvent = false;
    for (const envelope of selectedEventsForDisplay) {
      const event = envelope.event;
      if (event.type === "codex_goal_updated") {
        goalFromEvents = event.goal;
        sawGoalEvent = true;
      }
      if (event.type === "codex_goal_cleared") {
        goalFromEvents = null;
        sawGoalEvent = true;
      }
    }
    return sawGoalEvent ? goalFromEvents : (selectedSession?.codexGoal ?? null);
  }, [selectedEventsForDisplay, selectedSession?.codexGoal]);
  const selectedCodexTokenUsage = useMemo<CodexThreadTokenUsage | null>(() => {
    let usageFromEvents: CodexThreadTokenUsage | null = null;
    let sawUsageEvent = false;
    for (const envelope of selectedEventsForDisplay) {
      const event = envelope.event;
      if (event.type === "codex_token_usage") {
        usageFromEvents = event.usage;
        sawUsageEvent = true;
      }
    }
    return sawUsageEvent ? usageFromEvents : (selectedSession?.codexTokenUsage ?? null);
  }, [selectedEventsForDisplay, selectedSession?.codexTokenUsage]);
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  // The pane is runtime-agnostic — Codex emits subagent_started/progress/result
  // events for delegation and collabToolCall items (spawn_agent, etc.) just
  // like Claude. Gate on whether we have anything to display: snapshots OR an
  // active Codex chat goal (so the pane hosts the goal card even before any
  // subagents are spawned).
  const selectedSubagentPaneAvailable =
    selectedSubagentSnapshots.length > 0
    || (selectedSession?.provider === "codex" && Boolean(selectedCodexGoal?.objective));
  // Latest snapshot for the currently drilled-in subagent — keeps the
  // breadcrumb status in sync as the agent transitions running → completed.
  const subagentViewSnapshot = useMemo(() => {
    if (!subagentView) return null;
    return selectedSubagentSnapshots.find((s) => s.taskId === subagentView.taskId) ?? null;
  }, [subagentView, selectedSubagentSnapshots]);
  // Indicates at least one background subagent is currently running; used to
  // surface a small dot on the panel toggle when the panel is collapsed.
  const hasRunningBackgroundSubagent = useMemo(
    () => selectedSubagentSnapshots.some((s) => s.background === true && s.status === "running"),
    [selectedSubagentSnapshots],
  );
  // Auto-clear the subagent view when the underlying snapshot disappears
  // (e.g. session switch). Updating status is fine and stays in view.
  useEffect(() => {
    if (subagentView && !subagentViewSnapshot) {
      setSubagentView(null);
    }
  }, [subagentView, subagentViewSnapshot]);

  // Subagent transcript fetched via IPC for the drill-in view. `null` means
  // the runtime doesn't support transcript retrieval (LM Studio/Droid). `[]`
  // means we tried but the agent has not produced any messages yet.
  const [subagentTranscript, setSubagentTranscript] = useState<
    AgentChatSubagentTranscriptMessage[] | null
  >(null);
  const [subagentTranscriptLoading, setSubagentTranscriptLoading] = useState(false);
  const [subagentTranscriptUnsupported, setSubagentTranscriptUnsupported] = useState(false);

  useEffect(() => {
    if (!subagentView || !selectedSessionId) {
      setSubagentTranscript(null);
      setSubagentTranscriptLoading(false);
      setSubagentTranscriptUnsupported(false);
      return;
    }

    const fetchTranscript = window.ade?.agentChat?.getSubagentTranscript;
    if (typeof fetchTranscript !== "function") {
      setSubagentTranscript(null);
      setSubagentTranscriptUnsupported(true);
      return;
    }

    let cancelled = false;
    const isRunning = subagentViewSnapshot?.status === "running";

    const tick = async () => {
      try {
        setSubagentTranscriptLoading(true);
        const result = await fetchTranscript({
          sessionId: selectedSessionId,
          agentId: subagentView.agentId ?? subagentView.taskId,
          taskId: subagentView.taskId,
        });
        if (cancelled) return;
        if (result === null) {
          setSubagentTranscriptUnsupported(true);
          setSubagentTranscript(null);
        } else {
          setSubagentTranscriptUnsupported(false);
          setSubagentTranscript(result);
        }
      } catch (error) {
        // Log so debugging is possible; surface as empty transcript rather than
        // crashing the drill-in view. Polling tick will retry on the next
        // interval if the subagent is still running.
        // eslint-disable-next-line no-console
        console.error("agentChat.getSubagentTranscript failed", error);
        if (!cancelled) setSubagentTranscript([]);
      } finally {
        if (!cancelled) setSubagentTranscriptLoading(false);
      }
    };

    void tick();
    const intervalId = isRunning ? window.setInterval(() => { void tick(); }, 1500) : null;

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [subagentView, subagentViewSnapshot?.status, selectedSessionId]);
  const selectedTurnDiffSummaries = useMemo(() => deriveTurnDiffSummaries(selectedEvents), [selectedEvents]);
  const selectedTodoItems = useMemo(() => deriveTodoItems(selectedEvents), [selectedEvents]);
  const selectedPendingInputs = selectedSessionId ? (pendingInputsBySession[selectedSessionId] ?? []) : [];
  const pendingInput = selectedPendingInputs[0] ?? null;
  const planApprovalPendingInput = selectedPendingInputs.find((entry) =>
    isOrchestrationPlanApprovalRequest(entry.request),
  ) ?? null;
  const composerPendingInput = (() => {
    if (!pendingInput) return null;
    if (isOrchestrationPlanApprovalRequest(pendingInput.request)) {
      return { ...pendingInput.request, blocking: false, canProceedWithoutAnswer: true };
    }
    return pendingInput.request;
  })();
  const selectedSessionAwaitingInput = Boolean(pendingInput) || selectedSession?.awaitingInput === true;
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;
  const selectedCodexGoalPending = selectedSessionId ? (codexGoalPendingBySession[selectedSessionId] === true) : false;
  const setCodexGoalFromPanel = useCallback(async (sessionId: string, nextObjective: string) => {
    const objective = nextObjective.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!objective) return;
    setError(null);
    setCodexGoalPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
    try {
      await window.ade.agentChat.codex.setGoal({ sessionId, objective });
    } catch (goalError) {
      setError(errorMessage(goalError));
    } finally {
      setCodexGoalPendingBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
  }, []);
  const clearCodexGoalFromPanel = useCallback(async (sessionId: string) => {
    setError(null);
    setCodexGoalPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
    try {
      await window.ade.agentChat.codex.clearGoal({ sessionId });
    } catch (goalError) {
      setError(errorMessage(goalError));
    } finally {
      setCodexGoalPendingBySession((prev) => {
        if (!prev[sessionId]) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
    }
  }, []);
  // Per-session memo of which sessions have already triggered the auto-open
  // affordance, so the panel doesn't keep re-opening every time a new subagent
  // appears or the user navigates back to the chat. We only slide it in on the
  // *first* spawn within a session — after that, opening is up to the user.
  // Persisted to localStorage so the suppression survives remounts.
  const subagentAutoOpenedSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      cleanupSubagentAutoOpenStorage(window.localStorage);
    } catch {
      /* localStorage unavailable; fall back to in-memory ref */
    }
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      if (chatActionsOpen) setChatActionsOpen(false);
      return;
    }
    if (selectedSubagentSnapshots.length === 0) {
      return;
    }
    if (subagentAutoOpenedSessionsRef.current.has(selectedSessionId)) {
      return;
    }
    try {
      if (hasSubagentAutoOpenFired(window.localStorage, selectedSessionId)) {
        subagentAutoOpenedSessionsRef.current.add(selectedSessionId);
        return;
      }
    } catch {
      /* localStorage unavailable; fall back to in-memory ref */
    }
    subagentAutoOpenedSessionsRef.current.add(selectedSessionId);
    try {
      window.localStorage.setItem(
        getSubagentAutoOpenStorageKey(selectedSessionId),
        encodeSubagentAutoOpenRecord(Date.now()),
      );
    } catch {
      /* best-effort persistence */
    }
    if (!chatActionsOpen) {
      setChatActionsTab("agents");
      setIosSimulatorOpen(false);
      setAppControlOpen(false);
      setCursorCloudPaneOpen(false);
      setChatActionsOpen(true);
    }
  }, [chatActionsOpen, selectedSessionId, selectedSubagentSnapshots.length]);

  const persistParallelLaunchState = useCallback(async (state: AgentChatParallelLaunchState | null) => {
    if (!projectRoot || !laneId) return;
    try {
      await window.ade.agentChat.parallelLaunchState.set({
        projectRoot,
        parentLaneId: laneId,
        state,
      });
    } catch (persistError) {
      console.error("parallel launch state persist failed", {
        laneId,
        projectRoot,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      });
    }
  }, [laneId, projectRoot]);

  useEffect(() => {
    completionSoundPrevTurnActiveRef.current = false;
    completionSoundArmedRef.current = true;
  }, [selectedSessionId]);

  useEffect(() => {
    if (!projectRoot || !laneId) return;
    if (lockSessionId || initialSessionId) return;
    const recoveryKey = `${projectRoot}::${laneId}`;
    if (recoveredParallelLaunchKeyRef.current === recoveryKey) return;
    recoveredParallelLaunchKeyRef.current = recoveryKey;
    let cancelled = false;
    let recoveryTimer: number | null = null;

    const recoverParallelLaunchState = () => {
      void (async () => {
        let pendingState: AgentChatParallelLaunchState | null = null;
        try {
          pendingState = await window.ade.agentChat.parallelLaunchState.get({
            projectRoot,
            parentLaneId: laneId,
          });
        } catch {
          return;
        }
        if (!pendingState) return;
        if (isCompletedParallelLaunchState(pendingState)) {
          await persistParallelLaunchState(null);
          return;
        }

        if (!pendingState.createdLaneIds.length) {
          await persistParallelLaunchState(null);
          return;
        }

        if (cancelled) return;
        setParallelLaunchBusy(true);
        setParallelLaunchStatus("Cleaning up unfinished parallel launch…");
        const cleanupIssues = await cleanupTransientParallelLaunchLanes({
          laneIds: pendingState.createdLaneIds,
          deleteLane: (args) => window.ade.lanes.delete(args),
          refreshLanes: refreshLanesStore,
          onCleanupError: logParallelLaunchCleanupError,
        });

        if (cleanupIssues.length === 0) {
          await persistParallelLaunchState(null);
        } else {
          await persistParallelLaunchState(buildParallelLaunchState({
            parentLaneId: pendingState.parentLaneId,
            createdLaneIds: pendingState.createdLaneIds,
            sentLaneIds: pendingState.sentLaneIds,
            status: "cleanup_pending",
            lastError: pendingState.lastError,
          }));
          if (!cancelled) {
            setError(formatParallelLaunchFailureMessage({
              launchError: "Recovered an unfinished parallel launch from before ADE closed.",
              cleanupIssues,
            }));
          }
        }

        if (!cancelled) {
          setParallelLaunchBusy(false);
          setParallelLaunchStatus(null);
        }
      })();
    };

    if (isRemoteProject) {
      recoveryTimer = window.setTimeout(recoverParallelLaunchState, REMOTE_PARALLEL_LAUNCH_RECOVERY_DELAY_MS);
    } else {
      recoverParallelLaunchState();
    }

    return () => {
      cancelled = true;
      if (recoveryTimer != null) {
        window.clearTimeout(recoveryTimer);
      }
    };
  }, [
    initialSessionId,
    isRemoteProject,
    laneId,
    lockSessionId,
    persistParallelLaunchState,
    projectRoot,
    refreshLanesStore,
  ]);

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

  let activeProviderConnection: AiProviderConnectionStatus | null = null;
  switch (selectedSession?.provider) {
    case "claude":
      activeProviderConnection = providerConnections?.claude ?? null;
      break;
    case "codex":
      activeProviderConnection = providerConnections?.codex ?? null;
      break;
    case "cursor":
      activeProviderConnection = providerConnections?.cursor ?? null;
      break;
    case "droid":
      activeProviderConnection = providerConnections?.droid ?? null;
      break;
    default:
      activeProviderConnection = null;
      break;
  }
  const pendingApprovalIds = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of pendingInputsBySession[selectedSessionId ?? ""] ?? []) {
      ids.add(entry.itemId);
    }
    return ids;
  }, [pendingInputsBySession, selectedSessionId]);
  const pendingSteers = selectedSessionId ? (pendingSteersBySession[selectedSessionId] ?? []) : [];
  const selectedModelDesc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
  const reasoningTiers = selectedModelDesc?.reasoningTiers ?? EMPTY_REASONING_TIERS;
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
    && (
      activeProviderConnection.blocker
      || activeProviderConnection.provider === "cursor"
      || activeProviderConnection.provider === "droid"
    ),
  );
  const cliRuntimeTitle = activeProviderConnection?.provider === "claude"
    ? "Claude runtime"
    : activeProviderConnection?.provider === "cursor"
      ? "Cursor runtime"
      : activeProviderConnection?.provider === "droid"
        ? "Droid runtime"
      : "Codex runtime";
  const cliRuntimeBody = activeProviderConnection?.blocker
    ?? (activeProviderConnection?.provider === "droid"
      ? "Droid is not available. Install the Factory CLI, ensure `droid` is on PATH, and configure Factory authentication."
      : activeProviderConnection?.provider === "cursor"
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

  useEffect(() => () => {
    paneMountedRef.current = false;
  }, []);

  const modelSelectionDiffersFromSession = Boolean(selectedSession && selectedSessionModelId && selectedSessionModelId !== modelId);

  const sessionProvider = useMemo(() => {
    if (selectedSession && !modelSelectionDiffersFromSession) return selectedSession.provider;
    return resolveChatRuntimeProvider(resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId));
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

  const patchParallelSlot = useCallback((index: number, patch: Partial<ParallelModelRowState>) => {
    setParallelModelSlots((prev) => {
      if (index < 0 || index >= prev.length) return prev;
      const next = [...prev];
      next[index] = { ...next[index]!, ...patch };
      return next;
    });
  }, []);

  const parallelSlotCursorSnapshot = useMemo(() => {
    if (parallelConfiguringIndex == null) return null;
    const row = parallelModelSlots[parallelConfiguringIndex];
    if (!row) return null;
    if (resolveChatRuntimeProvider(getModelById(row.modelId)) !== "cursor") return null;
    const base = buildFallbackCursorModeSnapshot(row.cursorModeId);
    return {
      ...base,
      currentModeId: row.cursorModeId ?? base.currentModeId,
      configOptions: base.configOptions?.map((option) => {
        if (option.id === base.modeConfigId) {
          return { ...option, currentValue: row.cursorModeId ?? option.currentValue };
        }
        if (Object.prototype.hasOwnProperty.call(row.cursorConfigValues, option.id)) {
          return { ...option, currentValue: row.cursorConfigValues[option.id] ?? option.currentValue };
        }
        return option;
      }),
    };
  }, [parallelConfiguringIndex, parallelModelSlots]);

  const parallelComposerControlSlot = useMemo((): ParallelComposerControlSlot | null => {
    if (parallelConfiguringIndex == null) return null;
    const row = parallelModelSlots[parallelConfiguringIndex];
    if (!row) return null;
    const idx = parallelConfiguringIndex;
    const prov = resolveChatRuntimeProvider(getModelById(row.modelId));
    return {
      sessionProvider: prov,
      interactionMode: row.interactionMode,
      claudePermissionMode: row.claudePermissionMode,
      codexApprovalPolicy: row.codexApprovalPolicy,
      codexSandbox: row.codexSandbox,
      codexConfigSource: row.codexConfigSource,
      opencodePermissionMode: row.opencodePermissionMode,
      droidPermissionMode: row.droidPermissionMode,
      cursorModeSnapshot: parallelSlotCursorSnapshot,
      onInteractionModeChange: (mode) => patchParallelSlot(idx, { interactionMode: mode }),
      onClaudeModeChange: (mode) => patchParallelSlot(idx, {
        claudePermissionMode: mode,
        interactionMode: mode === 'plan' ? 'plan' : 'default',
      }),
      onClaudePermissionModeChange: (mode) => patchParallelSlot(idx, { claudePermissionMode: mode }),
      onCodexPresetChange: (next) => patchParallelSlot(idx, {
        codexApprovalPolicy: next.codexApprovalPolicy,
        codexSandbox: next.codexSandbox,
        codexConfigSource: next.codexConfigSource,
      }),
      onCodexApprovalPolicyChange: (policy) => patchParallelSlot(idx, { codexApprovalPolicy: policy }),
      onCodexSandboxChange: (sandbox) => patchParallelSlot(idx, { codexSandbox: sandbox }),
      onCodexConfigSourceChange: (source) => patchParallelSlot(idx, { codexConfigSource: source }),
      onOpenCodePermissionModeChange: (mode) => patchParallelSlot(idx, { opencodePermissionMode: mode }),
      onDroidPermissionModeChange: (mode) => patchParallelSlot(idx, { droidPermissionMode: mode }),
      onCursorModeChange: (modeId) => patchParallelSlot(idx, { cursorModeId: modeId }),
      onCursorConfigChange: (configId, value) => patchParallelSlot(idx, {
        cursorConfigValues: { ...row.cursorConfigValues, [configId]: value },
      }),
    };
  }, [parallelConfiguringIndex, parallelModelSlots, parallelSlotCursorSnapshot, patchParallelSlot]);

  const parallelConfiguringRow = parallelConfiguringIndex != null ? parallelModelSlots[parallelConfiguringIndex] ?? null : null;
  const parallelSlotExecutionModeOptions = useMemo(
    () => getExecutionModeOptions(parallelConfiguringRow ? getModelById(parallelConfiguringRow.modelId) : null),
    [parallelConfiguringRow],
  );

  const applyLaunchConfigToComposer = useCallback((config: LastLaunchConfig) => {
    const desc = resolveModelDescriptorWithRuntimeCatalog(config.modelId) ?? getModelById(config.modelId);
    if (!cursorModelAllowedForDraftKind(desc, workDraftKind)) return;
    const tiers = desc?.reasoningTiers ?? [];
    setModelId(config.modelId);
    setReasoningEffort(selectReasoningEffort({
      tiers,
      preferred: config.reasoningEffort,
    }));
    setCodexFastMode(modelSupportsFastMode(desc) && config.codexFastMode);
    setExecutionMode(config.executionMode);
    setInteractionMode(config.controls.interactionMode);
    setClaudePermissionMode(config.controls.claudePermissionMode);
    setCodexApprovalPolicy(config.controls.codexApprovalPolicy);
    setCodexSandbox(config.controls.codexSandbox);
    setCodexConfigSource(config.controls.codexConfigSource);
    setOpenCodePermissionMode(config.controls.opencodePermissionMode);
    setDroidPermissionMode(config.controls.droidPermissionMode);
    setCursorModeId(config.controls.cursorModeId);
    setCursorConfigValues({ ...config.controls.cursorConfigValues });
  }, [workDraftKind]);

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) {
      if (draftLaunchConfigTouchedKeyRef.current === draftLaunchConfigScopeKey) {
        return;
      }
      const lastLaunchConfig = readLatestLastLaunchConfig(lastLaunchConfigStorageKeys, initialNativeControls);
      if (lastLaunchConfig) {
        applyLaunchConfigToComposer(lastLaunchConfig);
        return;
      }
      setInteractionMode(initialNativeControls.interactionMode);
      setClaudePermissionMode(initialNativeControls.claudePermissionMode);
      setCodexApprovalPolicy(initialNativeControls.codexApprovalPolicy);
      setCodexSandbox(initialNativeControls.codexSandbox);
      setCodexConfigSource(initialNativeControls.codexConfigSource);
      setOpenCodePermissionMode(initialNativeControls.opencodePermissionMode);
      setDroidPermissionMode(initialNativeControls.droidPermissionMode);
      setCursorModeId(initialNativeControls.cursorModeId);
      setCursorConfigValues(initialNativeControls.cursorConfigValues);
      setCodexFastMode(false);
      return;
    }
    const nextModelId = session.modelId ?? resolveRegistryModelId(session.model);
    if (nextModelId) {
      setModelId(nextModelId);
    }
    setReasoningEffort(session.reasoningEffort ?? null);
    setCodexFastMode(session.codexFastMode === true);
    setExecutionMode(session.executionMode ?? "focused");
    setInteractionMode(session.interactionMode ?? initialNativeControls.interactionMode);
    setClaudePermissionMode(session.claudePermissionMode ?? initialNativeControls.claudePermissionMode);
    setCodexApprovalPolicy(session.codexApprovalPolicy ?? initialNativeControls.codexApprovalPolicy);
    setCodexSandbox(session.codexSandbox ?? initialNativeControls.codexSandbox);
    setCodexConfigSource(session.codexConfigSource ?? initialNativeControls.codexConfigSource);
    setOpenCodePermissionMode(session.opencodePermissionMode ?? initialNativeControls.opencodePermissionMode);
    setDroidPermissionMode(
      session.droidPermissionMode
        ?? legacyPermissionModeToDroidPermissionMode(session.permissionMode)
        ?? initialNativeControls.droidPermissionMode,
    );
    setCursorModeId(session.cursorModeId ?? session.cursorModeSnapshot?.currentModeId ?? initialNativeControls.cursorModeId);
    setCursorConfigValues(
      Object.fromEntries(
        (session.cursorModeSnapshot?.configOptions ?? [])
          .filter((option) => option.id !== session.cursorModeSnapshot?.modeConfigId)
          .flatMap((option) => option.currentValue == null ? [] : [[option.id, option.currentValue]]),
      ),
    );
  }, [applyLaunchConfigToComposer, draftLaunchConfigScopeKey, initialNativeControls, lastLaunchConfigStorageKeys]);
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
  const chatHeaderLane = laneId ? lanes.find((lane) => lane.id === laneId) ?? null : null;
  const chatHeaderLaneName = chatHeaderLane?.name ?? laneId ?? "lane";
  const chatHeaderLaneColor = getLaneAccent(chatHeaderLane, 0);
  const assistantLabel = presentation?.assistantLabel?.trim()
    || resolveAssistantLabel(selectedModelDesc, selectedSession?.provider);
  const defaultMessagePlaceholder =
    workDraftKind === "chat-orchestrator" && !selectedSessionId
      ? "Describe the orchestration goal..."
      : "Type to vibecode...";
  const messagePlaceholder = presentation?.messagePlaceholder?.trim() || defaultMessagePlaceholder;
  const effectiveMessagePlaceholder = projectTransitionBlocksChat
    ? "Project is switching..."
    : messagePlaceholder;
  const chipsJson = JSON.stringify(presentation?.chips ?? []);
  const resolvedChips = useMemo(() => JSON.parse(chipsJson) as ChatSurfaceChip[], [chipsJson]);

  // Keep configured models selectable unless a caller explicitly constrains
  // this surface. Unconstrained sessions keep their active model visible even
  // when it has fallen out of the discovered catalog.
  const modelSelectionConstrained = availableModelIdsOverride != null;
  const effectiveAvailableModelIds = useMemo(() => {
    const sourceAvailableModelIds = availableModelIdsOverride ?? availableModelIds;
    const base = filterChatModelIdsForSession({
      availableModelIds: sourceAvailableModelIds,
      activeSessionModelId: selectedSessionModelId,
      hasConversation: selectedEvents.length > 0,
      includeActiveSessionModel: !modelSelectionConstrained,
      policy: modelSwitchPolicy,
    });
    if (modelSelectionConstrained) return filterCursorModelIdsForDraftKind(base, workDraftKind);
    const catalog = getSharedRuntimeCatalog();
    if (!catalog) return filterCursorModelIdsForDraftKind(base, workDraftKind);
    const runtimeIds = descriptorsFromAgentChatModelCatalog(catalog).availableModelIds;
    if (!runtimeIds.length) return filterCursorModelIdsForDraftKind(base, workDraftKind);
    const merged = new Set(base);
    for (const id of runtimeIds) merged.add(id);
    return filterCursorModelIdsForDraftKind([...merged], workDraftKind);
  }, [availableModelIds, availableModelIdsOverride, modelSelectionConstrained, modelSwitchPolicy, selectedSessionModelId, selectedEvents.length, runtimeCatalogVersion, workDraftKind]);
  const modelPickerProviderAuthStatus = useMemo(
    () => (aiStatus ? familiesFromStatus(aiStatus) : undefined),
    [aiStatus],
  );
  const cursorCloudModelIds = useMemo(
    () => effectiveAvailableModelIds.filter((id) => id.startsWith("cursor/")),
    [effectiveAvailableModelIds],
  );
  const constrainedModelSelectionError = useMemo(() => {
    if (!modelSelectionConstrained) return null;
    if (!effectiveAvailableModelIds.length) {
      return "No models are available for this chat surface.";
    }
    if (modelId && !effectiveAvailableModelIds.includes(modelId)) {
      return "Select an available model for this chat surface before sending.";
    }
    return null;
  }, [effectiveAvailableModelIds, modelId, modelSelectionConstrained]);
  const cursorCloudApiAvailable = providerConnections?.cursor?.authAvailable === true
    || aiStatus?.availableProviders?.cursor === true;
  const cursorCloudAvailable = Boolean(laneId)
    && cursorCloudApiAvailable
    && (selectedSession?.provider === "cursor" || (typeof modelId === "string" && modelId.startsWith("cursor/")));
  // Launch-to-cloud is only allowed for a fresh chat: no events yet AND not already promoted to a
  // cloud agent. The "open existing cloud chat" affordance remains independent of this flag because
  // it spawns a brand-new session.
  const cursorCloudCanLaunch = cursorCloudAvailable
    && selectedEvents.length === 0
    && !selectedSession?.cursorCloudAgentId;
  useEffect(() => {
    if (!cursorCloudAvailable && cursorCloudPaneOpen) setCursorCloudPaneOpen(false);
  }, [cursorCloudAvailable, cursorCloudPaneOpen]);
  // If the chat is no longer fresh (events arrived, or it was promoted to a cloud agent) close the
  // inline launch strip so users can't accidentally fire a second cloud agent from a stale draft.
  useEffect(() => {
    if (!cursorCloudCanLaunch && cursorCloudLaunchModeOpen) setCursorCloudLaunchModeOpen(false);
  }, [cursorCloudCanLaunch, cursorCloudLaunchModeOpen]);
  useEffect(() => {
    if (!cursorCloudPaneOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCursorCloudPaneOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [cursorCloudPaneOpen]);
  useEffect(() => {
    if (!laneId) return;
    if (!cursorCloudPaneOpen && !cursorCloudLaunchModeOpen) return;
    let cancelled = false;
    void window.ade.git
      .getOriginRemote({ laneId })
      .then((info) => {
        if (cancelled) return;
        setLaneGitRemote(info?.remoteUrl ?? null);
        setLaneGitBranch(info?.branch ?? null);
      })
      .catch(() => {
        if (cancelled) return;
        setLaneGitRemote(null);
        setLaneGitBranch(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cursorCloudPaneOpen, cursorCloudLaunchModeOpen, laneId]);
  const [cursorCloudActiveCount, setCursorCloudActiveCount] = useState<number>(0);
  useEffect(() => {
    if (!cursorCloudAvailable) {
      setCursorCloudActiveCount(0);
      return;
    }
    let cancelled = false;
    async function poll() {
      try {
        const result = await window.ade.ai.cursorCloudListAgents({ limit: 16 });
        if (cancelled) return;
        const active = result.items.filter((agent) => {
          const s = (agent.status ?? "").toLowerCase();
          return s === "running" || s === "creating";
        }).length;
        setCursorCloudActiveCount(active);
      } catch { /* best-effort */ }
    }
    void poll();
    const interval = window.setInterval(poll, 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [cursorCloudAvailable]);
  // Runtime tracks whether sends go to the local agent or to a promoted Cursor Cloud agent. The
  // value is derived purely from session state — the previous renderer-side override (split-send
  // chevron) was removed when launches were funneled through the dedicated cloud composer surface.
  const cursorRuntime: "local" | "cloud" = selectedSession?.cursorRuntime
    ?? (selectedSession?.cursorCloudAgentId ? "cloud" : "local");
  const handoffAvailableModelIds = useMemo(() => {
    const merged = new Set<string>(availableModelIds);
    const catalog = getSharedRuntimeCatalog();
    if (catalog) {
      for (const id of descriptorsFromAgentChatModelCatalog(catalog).availableModelIds) {
        merged.add(id);
      }
    }
    if (selectedSessionModelId) {
      merged.add(selectedSessionModelId);
    }
    const filtered = filterCursorModelIdsForDraftKind([...merged], "chat");
    const ordered = MODEL_REGISTRY
      .filter((model) => !model.deprecated && filtered.includes(model.id))
      .map((model) => model.id);
    const extras = filtered.filter((modelId) => !ordered.includes(modelId));
    extras.sort((left, right) => {
      const leftLabel = getModelById(left)?.displayName ?? left;
      const rightLabel = getModelById(right)?.displayName ?? right;
      return leftLabel.localeCompare(rightLabel, undefined, { sensitivity: "base" });
    });
    return [...ordered, ...extras];
  }, [availableModelIds, runtimeCatalogVersion, selectedSessionModelId]);
  const canShowHandoff = Boolean(
    lockSessionId
      && selectedSessionId
      && selectedSession
      && onSessionCreated
      && handoffAvailableModelIds.length > 0
      && surfaceMode === "standard"
      && !isPersistentIdentitySurface
      && (selectedSession.surface ?? "work") === "work",
  );
  const chatActionsHandoffActive = chatActionsOpen && chatActionsTab === "handoff";
  const handoffTargetDescriptor = useMemo(
    () => (handoffModelId ? (getModelById(handoffModelId) ?? null) : null),
    [handoffModelId],
  );
  const handoffTargetProvider = useMemo(
    () => (handoffTargetDescriptor ? resolveProviderGroupForModel(handoffTargetDescriptor) : null),
    [handoffTargetDescriptor],
  );
  const handoffNativeControlState = useMemo((): NativeControlState => ({
    interactionMode,
    claudePermissionMode: handoffClaudePermissionMode,
    codexApprovalPolicy: handoffCodexApprovalPolicy,
    codexSandbox: handoffCodexSandbox,
    codexConfigSource: handoffCodexConfigSource,
    opencodePermissionMode: handoffOpenCodePermissionMode,
    droidPermissionMode: handoffDroidPermissionMode,
    cursorModeId: handoffCursorModeId,
    cursorConfigValues: handoffCursorConfigValues,
  }), [
    interactionMode,
    handoffClaudePermissionMode,
    handoffCodexApprovalPolicy,
    handoffCodexSandbox,
    handoffCodexConfigSource,
    handoffOpenCodePermissionMode,
    handoffDroidPermissionMode,
    handoffCursorModeId,
    handoffCursorConfigValues,
  ]);
  const handoffNativePermissionMode = useMemo((): AgentChatPermissionMode | undefined | null => {
    if (!handoffTargetProvider) return null;
    return summarizeNativeControls(handoffTargetProvider, handoffNativeControlState).permissionMode
      ?? undefined;
  }, [handoffTargetProvider, handoffNativeControlState]);
  const handoffCodexPermissionPreset = useMemo(
    () =>
      resolveHandoffCodexPreset({
        codexApprovalPolicy: handoffCodexApprovalPolicy,
        codexSandbox: handoffCodexSandbox,
        codexConfigSource: handoffCodexConfigSource,
      }),
    [handoffCodexApprovalPolicy, handoffCodexSandbox, handoffCodexConfigSource],
  );
  const handoffCodexSelectValue: "default" | "edit" | "plan" | "full-auto" | "config-toml" =
    handoffCodexPermissionPreset === "custom" ? "default" : handoffCodexPermissionPreset;
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

  const refreshAvailableModels = useCallback(async (options?: { force?: boolean }) => {
    ++availableModelsRefreshSeqRef.current;
    const selectedModelProvider = modelId.trim()
      ? resolveChatRuntimeProvider(resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId))
      : null;
    const shouldRefreshOpenCodeInventory =
      sessionProvider === "opencode"
      && (
        selectedSession?.provider === "opencode"
        || selectedModelProvider === "opencode"
      );
    if (options?.force === true) {
      invalidateAiDiscoveryCache(projectRoot);
    }
    try {
      const status = await getAiStatusCached({
        projectRoot,
        force: options?.force === true,
        ...(shouldRefreshOpenCodeInventory ? { refreshOpenCodeInventory: true } : {}),
      });
      setAiStatus(status);
      setProviderConnections({
        claude: status.providerConnections?.claude ?? null,
        codex: status.providerConnections?.codex ?? null,
        cursor: status.providerConnections?.cursor ?? null,
        droid: status.providerConnections?.droid ?? null,
      });
      const available = deriveConfiguredModelIds(status, { includeDroid: true });
      const orderedAvailable = orderAvailableModelIds(available);
      setAvailableModelIds(orderedAvailable);
      return orderedAvailable;
    } catch {
      setAiStatus(null);
      setProviderConnections(null);
      // Fall back to direct model discovery probes below.
    }

    try {
      const [codexModels, claudeModels, cursorModels, droidModels, openCodeModels] = await Promise.all([
        getAgentChatModelsCached({ projectRoot, provider: "codex" }).catch(() => []),
        getAgentChatModelsCached({ projectRoot, provider: "claude" }).catch(() => []),
        getAgentChatModelsCached({ projectRoot, provider: "cursor", activateRuntime: true }).catch(() => []),
        getAgentChatModelsCached({ projectRoot, provider: "droid" }).catch(() => []),
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
      for (const model of droidModels) {
        const resolved = resolveCliRegistryModelId("droid", model.id);
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

      const allAvailable = orderAvailableModelIds(available);
      setAvailableModelIds(allAvailable);
      return allAvailable;
    } catch {
      setAvailableModelIds([]);
      return [];
    }
  }, [modelId, projectRoot, selectedSession?.provider, sessionProvider]);

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

  const invalidateCurrentChatSessionList = useCallback(() => {
    invalidateAgentChatSessionListCache(laneId ? { laneId } : undefined);
  }, [laneId]);

  const refreshLockedSessionSummary = useCallback(async () => {
    if (!lockSessionId) {
      setSessions([]);
      setArchivedSessions([]);
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

  const refreshSessions = useCallback(async (options?: { force?: boolean }) => {
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

    const allRows = await listAgentChatSessionsCached(
      { laneId },
      options?.force ? { force: true } : undefined,
    );
    const rows = allRows.filter((session) => !session.archivedAt);
    setArchivedSessions(sortSessionSummariesByRecency(
      allRows.filter((session) => Boolean(session.archivedAt)),
      localTouchBySessionRef.current,
    ));
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

  useEffect(() => {
    if (!isTileActive) return;
    void refreshAvailableModels();
  }, [isTileActive, refreshAvailableModels, selectedSession?.provider]);

  useEffect(() => {
    // Suspend the 5s model-list poll when this pane is mounted but hidden
    // (e.g. a background tab/tile). Streaming event subscriptions remain
    // so background sessions stay in sync, but polling is paused to avoid
    // wasted IPC for panes the user can't see.
    if (!turnActive || !selectedSession?.provider) return;
    if (!isTileActive) return;
    const timer = window.setInterval(() => {
      void refreshAvailableModels();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refreshAvailableModels, selectedSession?.provider, turnActive, isTileActive]);

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

  const clearSessionView = useCallback((sessionId: string) => {
    deleteAgentChatSessionViewCache(sessionId);
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: [] };
    setEventsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: [] }));
  }, []);

  const applyCachedSessionView = useCallback((sessionId: string): boolean => {
    const cached = readAgentChatSessionViewCache(sessionId);
    if (!cached) return false;
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: cached.events };
    loadedHistoryRef.current.add(sessionId);
    setEventsBySession((prev) => ({ ...prev, [sessionId]: cached.events }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: cached.turnActive }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: cached.pendingInputs }));
    setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: cached.pendingSteers }));
    return true;
  }, []);

  const loadHistory = useCallback(async (sessionId: string, options?: { force?: boolean }) => {
    if (options?.force) {
      loadedHistoryRef.current.delete(sessionId);
    }
    if (loadedHistoryRef.current.has(sessionId)) return;
    loadedHistoryRef.current.add(sessionId);

    try {
      // Prefer the main-process snapshot API which merges the in-memory event
      // ring buffer with the on-disk transcript. This recovers events that
      // were emitted while the user was on a different project (IPC dropped),
      // events that were still in fs.appendFile flight when a previous load
      // ran, and recent transcript history even when the transcript has been
      // truncated for size. Fall back to the disk-only readTranscriptTail path if the
      // snapshot call fails or the desktop app is running against an older
      // main-process build that lacks the handler.
      let parsed: AgentChatEventEnvelope[] = [];
      let usedSnapshotPath = false;
      try {
        if (typeof window.ade.agentChat.getEventHistory === "function") {
          const snapshot: AgentChatEventHistorySnapshot = await window.ade.agentChat.getEventHistory({
            sessionId,
            maxEvents: MAX_SELECTED_CHAT_SESSION_EVENTS,
          });
          if (snapshot?.sessionId === sessionId && snapshot.sessionFound === false) {
            clearSessionView(sessionId);
            loadedHistoryRef.current.delete(sessionId);
            return;
          }
          if (snapshot?.sessionId === sessionId && !snapshot.events?.length && snapshot.sessionFound !== true) {
            const summary = await window.ade.agentChat.getSummary({ sessionId }).catch(() => null);
            if (!summary) {
              clearSessionView(sessionId);
              loadedHistoryRef.current.delete(sessionId);
              return;
            }
          }
          if (snapshot?.events?.length || snapshot?.sessionId === sessionId) {
            parsed = (snapshot.events ?? []).filter((entry) => entry.sessionId === sessionId);
            usedSnapshotPath = true;
          }
        }
      } catch {
        usedSnapshotPath = false;
      }
      if (!usedSnapshotPath) {
        const summary = await window.ade.sessions.get(sessionId);
        if (!summary || !isChatToolType(summary.toolType)) {
          // Clear the loaded flag so a subsequent remount/tab switch can retry.
          // Without this, a transient lookup miss (e.g. session summary not yet
          // propagated on project switch) would leave the UI permanently
          // unable to hydrate history. Mirrors the catch-block recovery below.
          loadedHistoryRef.current.delete(sessionId);
          return;
        }
        const raw = await window.ade.sessions.readTranscriptTail({
          sessionId,
          maxBytes: CHAT_HISTORY_READ_MAX_BYTES,
          raw: true
        });
        parsed = parseAgentChatTranscript(raw).filter((entry) => entry.sessionId === sessionId);
      }

      // If real-time events have already been received for this session
      // (via flushQueuedEvents), the snapshot may be stale by a few events.
      // Merge by event identity and stream overlap. Sequence numbers are only
      // monotonic within a single provider run; Claude fallback/resume can
      // restart them while keeping the same ADE chat id.
      const existing = eventsBySessionRef.current[sessionId] ?? [];
      let merged = mergeChatHistorySnapshot(parsed, existing);
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
      writeAgentChatSessionViewCache(sessionId, merged, derived);
      eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: merged };
      setEventsBySession((prev) => ({ ...prev, [sessionId]: merged }));
      setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: allowRunningFromSummary ? derived.turnActive : false }));
      setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: derived.pendingInputs }));
      setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: derived.pendingSteers }));
    } catch {
      // Clear the loaded flag so the caller can retry on next remount or tab
      // switch — otherwise a transient failure leaves the UI stuck with no
      // events. Without this clearSessionView, a failed initial load
      // permanently blocked re-entry until the chat received a new event.
      loadedHistoryRef.current.delete(sessionId);
    }
  }, [clearSessionView, initialSessionSummary, lockSessionId]);

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
    draftLaunchConfigHydratedRef.current = null;
    draftLaunchConfigTouchedKeyRef.current = null;
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
    selectedSession?.droidPermissionMode,
    selectedSession?.permissionMode,
    selectedSession?.cursorModeId,
    selectedSession?.cursorModeSnapshot?.currentModeId,
    selectedSession?.cursorModeSnapshot?.configOptions,
    syncComposerToSession,
  ]);

  useEffect(() => {
    if (selectedSessionId || lockSessionId) return;
    if (draftLaunchConfigTouchedKeyRef.current === draftLaunchConfigScopeKey) return;
    const draftKey = draftLaunchConfigScopeKey;
    const latestSessionConfig = sessions[0]
      ? buildLastLaunchConfig(sessions[0], initialNativeControls)
      : null;
    const sessionHydrationKey = `${draftKey}:session`;
    if (latestSessionConfig) {
      if (draftLaunchConfigHydratedRef.current === sessionHydrationKey) return;
      applyLaunchConfigToComposer(latestSessionConfig);
      draftLaunchConfigHydratedRef.current = sessionHydrationKey;
      return;
    }

    const storageHydrationKey = `${draftKey}:storage`;
    if (draftLaunchConfigHydratedRef.current === storageHydrationKey) return;
    const storedConfig = readLatestLastLaunchConfig(lastLaunchConfigStorageKeys, initialNativeControls);
    if (!storedConfig) return;
    applyLaunchConfigToComposer(storedConfig);
    draftLaunchConfigHydratedRef.current = storageHydrationKey;
  }, [
    applyLaunchConfigToComposer,
    initialNativeControls,
    draftLaunchConfigScopeKey,
    laneId,
    lastLaunchConfigStorageKeys,
    lockSessionId,
    projectRoot,
    selectedSessionId,
    sessions,
    surfaceProfile,
    workDraftKind,
  ]);

  useEffect(() => {
    if (!isTileActive || !selectedSessionId || !selectedSessionModelId || turnActive) return;
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
    isTileActive,
    turnActive,
  ]);

  useEffect(() => {
    let cancelled = false;

    const boot = async () => {
      const hasRenderableSession = Boolean(selectedSessionIdRef.current || lockSessionId || initialSessionSummary);
      setLoading(!hasRenderableSession);
      setPreferencesReady(false);
      try {
        const snapshot = await getProjectConfigCached({ projectRoot });
        const chat = snapshot.effective.ai?.chat;
        if (!cancelled) {
          // Don't auto-restore model — user must pick one explicitly each session
          setSendOnEnter(chat?.sendOnEnter ?? true);
        }
      } catch {
        // fall back to defaults.
      }

      const sessionsRefresh = refreshSessions().catch(() => undefined);
      const modelsRefresh = refreshAvailableModels().catch(() => []);
      try {
        await sessionsRefresh;
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
      try {
        await modelsRefresh;
      } finally {
        if (!cancelled) {
          setPreferencesReady(true);
        }
      }
    };

    void boot();
    return () => {
      cancelled = true;
    };
  }, [initialSessionSummary, lockSessionId, refreshAvailableModels, refreshSessions]);

  useEffect(() => {
    const selectableModelIds = modelSelectionConstrained ? effectiveAvailableModelIds : availableModelIds;
    if (loading || !selectableModelIds.length) return;
    // If the user hasn't picked a model yet, don't auto-select one.
    if (!modelId) return;
    if (selectableModelIds.includes(modelId)) return;
    if (modelSelectionConstrained) return;
    const modelDesc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
    if (modelDesc?.family === "cursor" && !cursorModelAllowedForDraftKind(modelDesc, workDraftKind)) {
      if (selectedSessionModelId && effectiveAvailableModelIds.includes(selectedSessionModelId)) {
        setModelId(selectedSessionModelId);
        return;
      }
      const preferred = readLastUsedModelId();
      setModelId(preferred && effectiveAvailableModelIds.includes(preferred) ? preferred : effectiveAvailableModelIds[0] ?? "");
      return;
    }
    // Runtime catalog can surface Cursor/Droid SDK models before ai status catches up.
    if (isKnownSelectableChatModelId(modelId) || modelDesc) return;
    if (selectedSessionModelId && selectableModelIds.includes(selectedSessionModelId)) {
      setModelId(selectedSessionModelId);
      return;
    }
    const preferred = readLastUsedModelId();
    if (preferred && selectableModelIds.includes(preferred)) {
      setModelId(preferred);
    } else {
      setModelId(selectableModelIds[0]!);
    }
  }, [loading, availableModelIds, effectiveAvailableModelIds, modelId, modelSelectionConstrained, selectedSessionModelId, workDraftKind]);

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
    const sessionsApi = window.ade?.sessions;
    if (!sessionsApi?.onChanged || !sessionsApi.get || !chatTerminalVisible) return undefined;

    let disposed = false;
    const revealCreatedTerminal = async (sessionId: string) => {
      let session: TerminalSessionDetail | null = null;
      try {
        session = await sessionsApi.get(sessionId);
      } catch {
        return;
      }
      if (disposed || !session) return;
      const selectedChatSessionId = selectedSessionIdRef.current;
      if (!selectedChatSessionId || session.chatSessionId !== selectedChatSessionId) return;
      if (session.laneId !== laneId) return;
      const ptyId = typeof session.ptyId === "string" ? session.ptyId.trim() : "";
      if (!ptyId) return;

      setTerminalDrawerOpen(true);
      setTerminalRevealRequest({
        terminalId: session.id,
        ptyId,
        label: session.title?.trim() || "Terminal",
        nonce: ++terminalRevealNonceRef.current,
      });
    };

    const unsubscribe = sessionsApi.onChanged((event) => {
      if (event.reason !== "created") return;
      void revealCreatedTerminal(event.sessionId);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [chatTerminalVisible, laneId]);

  useEffect(() => {
    const api = window.ade?.iosSimulator;
    if (!api?.onEvent || hideLaneToolDrawers) return undefined;
    return api.onEvent((event) => {
      if (event.type !== "drawer-open-requested") return;
      const eventChatSessionId = typeof event.chatSessionId === "string" && event.chatSessionId.trim().length
        ? event.chatSessionId.trim()
        : null;
      const eventLaneId = typeof event.laneId === "string" && event.laneId.trim().length
        ? event.laneId.trim()
        : null;
      if (eventChatSessionId && eventChatSessionId !== selectedSessionIdRef.current) return;
      if (eventLaneId && laneId && eventLaneId !== laneId) return;
      if (!eventChatSessionId && !eventLaneId && !isTileActive) return;
      setIosSimulatorAvailable(true);
      setChatActionsOpen(false);
      setAppControlOpen(false);
      setCursorCloudPaneOpen(false);
      setIosSimulatorOpen(true);
      setIosSimulatorDrawerModeRequest({ mode: event.mode, nonce: Date.now() });
    });
  }, [hideLaneToolDrawers, isTileActive, laneId]);

  useEffect(() => {
    if (!iosSimulatorOpen && iosSimulatorDrawerModeRequest) {
      setIosSimulatorDrawerModeRequest(null);
    }
  }, [iosSimulatorOpen, iosSimulatorDrawerModeRequest]);

  useEffect(() => {
    setIosSimulatorDrawerModeRequest(null);
  }, [selectedSessionId, laneId]);

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
    if (!chatActionsHandoffActive) return;
    const preferredTargetId = handoffAvailableModelIds.find((id) => id !== selectedSessionModelId) ?? handoffAvailableModelIds[0] ?? "";
    setHandoffModelId((current) => {
      if (current && handoffAvailableModelIds.includes(current)) {
        return current;
      }
      return preferredTargetId;
    });
  }, [chatActionsHandoffActive, handoffAvailableModelIds, selectedSessionModelId]);

  const prevHandoffOpenRef = useRef(false);
  useEffect(() => {
    if (chatActionsHandoffActive && !prevHandoffOpenRef.current) {
      setHandoffReasoningEffort(reasoningEffort ?? null);
      setHandoffCodexFastMode(codexFastMode);
      setHandoffClaudePermissionMode(claudePermissionMode);
      setHandoffCodexApprovalPolicy(codexApprovalPolicy);
      setHandoffCodexSandbox(codexSandbox);
      setHandoffCodexConfigSource(codexConfigSource);
      setHandoffOpenCodePermissionMode(opencodePermissionMode);
      setHandoffDroidPermissionMode(droidPermissionMode);
      setHandoffCursorModeId(cursorModeId);
      setHandoffCursorConfigValues({ ...cursorConfigValues });
    }
    prevHandoffOpenRef.current = chatActionsHandoffActive;
    // Intentional: one-shot on open; avoid resetting the handoff form when underlying composer state changes while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatActionsHandoffActive]);

  useEffect(() => {
    if (!chatActionsHandoffActive || !handoffModelId) return;
    setHandoffReasoningEffort((prev) => clampHandoffReasoningToModel(prev, handoffTargetDescriptor));
  }, [chatActionsHandoffActive, handoffModelId, handoffTargetDescriptor]);

  useEffect(() => {
    if (!isTileVisible) return;
    if (!selectedSessionId) return;
    const restoredFromCache = applyCachedSessionView(selectedSessionId);
    const refreshOptions = { force: !restoredFromCache };
    if (!lockedSingleSessionMode) {
      // Re-read the selected transcript on every tab switch so the selected
      // chat can recover from any background event loss instead of relying
      // solely on the in-memory background buffer.
      void loadHistory(selectedSessionId, refreshOptions);
      if (!restoredFromCache) return;
      const refreshHandle = window.setTimeout(() => {
        void loadHistory(selectedSessionId, { force: true });
      }, 650);
      return () => window.clearTimeout(refreshHandle);
    }
    // Locked-single-session mode (Work tab tile). Force-reload on every mount
    // so that when the pane is unmounted and remounted (tab switch, project
    // switch, session tile activation) we always pull the freshest snapshot
    // rather than short-circuiting on a stale loadedHistoryRef from the
    // previous component instance.
    const hydrateDelayMs = isTileActive
      ? 0
      : 220 + (stableSessionDelayOffset(selectedSessionId) % 260);
    const handle = window.setTimeout(() => {
      void loadHistory(selectedSessionId, refreshOptions);
    }, hydrateDelayMs);
    let refreshHandle: number | null = null;
    if (restoredFromCache) {
      refreshHandle = window.setTimeout(() => {
        void loadHistory(selectedSessionId, { force: true });
      }, Math.max(650, hydrateDelayMs + 650));
    }
    return () => {
      window.clearTimeout(handle);
      if (refreshHandle != null) window.clearTimeout(refreshHandle);
    };
  }, [applyCachedSessionView, isTileActive, isTileVisible, loadHistory, lockedSingleSessionMode, selectedSessionId]);

  useEffect(() => {
    if (!isTileVisible || !selectedSessionId) return undefined;
    const shouldRecoverLiveTranscript =
      turnActive
      || selectedSession?.status === "active"
      || selectedSessionAwaitingInput;
    if (!shouldRecoverLiveTranscript) return undefined;

    let disposed = false;
    const offset = stableSessionDelayOffset(selectedSessionId);
    const initialDelayMs = isTileActive ? 900 : 1200 + (offset % 500);
    const intervalMs = isTileActive ? 2200 : 2800 + (offset % 700);
    const recover = () => {
      if (disposed) return;
      void loadHistory(selectedSessionId, { force: true });
    };
    const initialTimer = window.setTimeout(recover, initialDelayMs);
    const intervalTimer = window.setInterval(recover, intervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, [
    isTileActive,
    isTileVisible,
    loadHistory,
    selectedSession?.status,
    selectedSessionAwaitingInput,
    selectedSessionId,
    turnActive,
  ]);

  useEffect(() => {
    if (!isTileActive) {
      setComputerUseSnapshot(null);
      return;
    }
    if (isRemoteProject && !(chatActionsOpen && chatActionsTab === "proof")) {
      setComputerUseSnapshot(null);
      return;
    }
    if (!lockedSingleSessionMode) {
      void refreshComputerUseSnapshot(selectedSessionId);
      return;
    }
    const handle = window.setTimeout(() => {
      void refreshComputerUseSnapshot(selectedSessionId);
    }, 180);
    return () => window.clearTimeout(handle);
  }, [
    chatActionsOpen,
    chatActionsTab,
    isRemoteProject,
    isTileActive,
    lockedSingleSessionMode,
    refreshComputerUseSnapshot,
    selectedSessionId,
  ]);

  useEffect(() => {
    setPromptSuggestion(null);
    setChatActionsOpen(false);
    setHandoffBusy(false);
    optimisticOutgoingMessageRef.current = null;
    setOptimisticOutgoingMessage(null);
    // The full composer bucket effect above owns draft/context hydration for
    // session and lane switches; this effect resets transient chat UI only.
  }, [selectedSessionId, laneId]);

  useEffect(() => {
    optimisticOutgoingMessageRef.current = optimisticOutgoingMessage;
  }, [optimisticOutgoingMessage]);

  // Update the ref synchronously alongside the state setter so the chat event
  // handler at the top of this component can immediately observe the optimistic
  // envelope. If we rely on the useEffect above, the dedup branch may run with
  // a stale (null) ref when the backend's real `user_message` envelope arrives
  // in the same microtask as the send IPC resolving — producing a duplicate
  // bubble that only clears on tab unmount.
  const setOptimisticOutgoingMessageSynced = useCallback((next: { sessionId: string; envelope: AgentChatEventEnvelope } | null) => {
    optimisticOutgoingMessageRef.current = next;
    setOptimisticOutgoingMessage(next);
  }, []);

  useEffect(() => {
    const optimistic = optimisticOutgoingMessageRef.current;
    if (!optimistic) return;
    const committedEvents = eventsBySession[optimistic.sessionId] ?? [];
    if (!hasMatchingCommittedUserMessage(committedEvents, optimistic.envelope)) return;
    setOptimisticOutgoingMessageSynced(null);
  }, [eventsBySession, setOptimisticOutgoingMessageSynced]);

  // Fetch provider slash commands when session, lane, or draft provider changes.
  useEffect(() => {
    if (!isTileActive) { setSdkSlashCommands([]); return; }
    if (!selectedSessionId && !laneId) { setSdkSlashCommands([]); return; }
    let cancelled = false;
    const args = selectedSessionId
      ? { sessionId: selectedSessionId, projectRoot }
      : { laneId, provider: sessionProvider, projectRoot };
    getAgentChatSlashCommandsCached(args)
      .then((cmds) => { if (!cancelled) setSdkSlashCommands(cmds); })
      .catch(() => { if (!cancelled) setSdkSlashCommands([]); });
    return () => { cancelled = true; };
  }, [isTileActive, laneId, projectRoot, selectedSessionId, sessionProvider]);

  const sessionDeltaTurnActiveRef = useRef(false);
  const sessionDeltaSessionIdRef = useRef<string | null>(null);
  const remoteDeltaArmedSessionsRef = useRef<Set<string>>(new Set());

  // Fetch git diff stats when the session changes or a turn completes. Remote
  // chats skip the mount-time decoration fetch; the bridge should stay focused
  // on loading the transcript until the user actually runs a turn.
  useEffect(() => {
    if (!selectedSessionId || !isTileActive) { setSessionDelta(null); return; }
    const sameSession = sessionDeltaSessionIdRef.current === selectedSessionId;
    const previousTurnActive = sameSession ? sessionDeltaTurnActiveRef.current : false;
    sessionDeltaSessionIdRef.current = selectedSessionId;
    sessionDeltaTurnActiveRef.current = turnActive;
    if (isRemoteProject) {
      const completedTurn =
        remoteDeltaArmedSessionsRef.current.has(selectedSessionId)
        && sameSession
        && previousTurnActive
        && !turnActive;
      if (!completedTurn) {
        if (!turnActive) setSessionDelta(null);
        return;
      }
      remoteDeltaArmedSessionsRef.current.delete(selectedSessionId);
    }
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
  }, [isRemoteProject, isTileActive, selectedSessionId, turnActive]);

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
      const envelopeKey = chatEventDedupKey(envelope);
      if (sessionEvents.some((event) => chatEventDedupKey(event) === envelopeKey)) {
        continue;
      }
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
      writeAgentChatSessionViewCache(sessionId, next[sessionId] ?? [], derived);
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
    if (!isTileVisible) return undefined;
    const unsubscribe = window.ade.agentChat.onEvent((envelope) => {
      const optimistic = optimisticOutgoingMessageRef.current;
      if (
        optimistic?.sessionId === envelope.sessionId
        && envelope.event.type === "user_message"
        && isMatchingOptimisticUserMessage(envelope, optimistic.envelope)
      ) {
        optimisticOutgoingMessageRef.current = null;
        setOptimisticOutgoingMessage(null);
      }
      const acceptsEvent =
        knownSessionIdsRef.current.has(envelope.sessionId)
        || optimisticSessionIdsRef.current.has(envelope.sessionId)
        || pendingSelectedSessionIdRef.current === envelope.sessionId;
      if (!acceptsEvent) return;

      // session_meta_updated is a UI-state-only patch — don't queue it as a
      // chat event since it doesn't represent transcript content.
      if (envelope.event.type === "session_meta_updated") {
        const meta = envelope.event;
        if (typeof meta.title === "string" && meta.title.length > 0) {
          patchSessionSummary(envelope.sessionId, { title: meta.title });
        }
        return;
      }

      pendingEventQueueRef.current.push(envelope);
      const touchTimestamp = getChatSessionLocalTouchTimestampForEvent(envelope);
      if (touchTimestamp) {
        touchSession(envelope.sessionId, touchTimestamp);
      }
      if (
        envelope.event.type === "user_message"
        || (envelope.event.type === "status" && envelope.event.turnStatus === "started")
      ) {
        if (isRemoteProject && envelope.event.type === "status") {
          remoteDeltaArmedSessionsRef.current.add(envelope.sessionId);
        }
        patchSessionSummary(envelope.sessionId, {
          status: "active",
          idleSinceAt: null,
          awaitingInput: false,
          lastActivityAt: envelope.timestamp,
        });
      }

      // User messages and lifecycle edges must flush immediately so the
      // optimistic bubble cannot disappear behind the 16ms debounce and
      // visible grid tiles show fresh activity without requiring focus.
      if (
        envelope.event.type === "done"
        || envelope.event.type === "user_message"
        || envelope.event.type === "status"
        || (layoutVariant === "grid-tile" && isTileVisible)
      ) {
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
          // Apply the transition to the composer's mode chip directly from this
          // authoritative event. The session refresh below is async + debounced
          // and only re-syncs the chip if the refetched session's mode actually
          // changes — so if the refetch is stale/raced (e.g. during compaction)
          // the chip would otherwise stay stuck on "plan" after the plan is
          // accepted. Setting it here makes the change immediate and race-proof.
          if (envelope.sessionId === selectedSessionIdRef.current) {
            if (transition === "entered_plan_mode") {
              setInteractionMode("plan");
            } else {
              setInteractionMode("default");
              // The Claude mode picker also writes "plan" into claudePermissionMode
              // (handleClaudeModeChange), so clear it too — otherwise the chip
              // would still render "plan" via the access-mode fall-through.
              setClaudePermissionMode((prev) => (prev === "plan" ? "default" : prev));
            }
          }
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
          getAgentChatSlashCommandsCached(
            { sessionId: envelope.sessionId },
            {
              force: envelope.event.type === "system_notice",
            },
          )
            .then(setSdkSlashCommands)
            .catch(() => {});
        }
      }
    });
    return unsubscribe;
  }, [isRemoteProject, isTileVisible, layoutVariant, lockSessionId, flushQueuedEvents, patchSessionSummary, scheduleQueuedEventFlush, scheduleSessionsRefresh, touchSession]);

  useEffect(() => {
    if (!isTileActive) return undefined;
    if (isRemoteProject && !(chatActionsOpen && chatActionsTab === "proof")) {
      return undefined;
    }
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      if (!selectedSessionId) return;
      if (event.owner?.kind === "chat_session" && event.owner.id === selectedSessionId) {
        void refreshComputerUseSnapshot(selectedSessionId, { force: true });
      }
    });
    return unsubscribe;
  }, [
    chatActionsOpen,
    chatActionsTab,
    isRemoteProject,
    isTileActive,
    refreshComputerUseSnapshot,
    selectedSessionId,
  ]);

  useEffect(() => {
    if (!selectedSessionId) {
      setChatActionsOpen(false);
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
    latestAttachmentRef.current = { path: attachment.path, type: attachment.type, addedAt: Date.now() };
    setAttachments((prev) => {
      if (prev.some((entry) => entry.path === attachment.path)) return prev;
      return [...prev, attachment];
    });
  }, []);

  const addIosElementContext = useCallback((item: IosElementContextItem) => {
    const nextSurface = iosContextSurface(item);
    const replacedAttachmentPaths = iosElementContextItems
      .filter((entry) => iosContextSurface(entry) !== nextSurface)
      .map(getIosContextAttachmentPath)
      .filter((path): path is string => Boolean(path));
    const latestAttachment = latestAttachmentRef.current;
    const attachmentPath = item.screenshotDataUrl
      && latestAttachment?.type === "image"
      && Date.now() - latestAttachment.addedAt < 10_000
      && !linkedIosAttachmentPathsRef.current.has(latestAttachment.path)
        ? latestAttachment.path
        : null;
    const instanceId = createIosContextInstanceId(item);
    if (attachmentPath) {
      linkedIosAttachmentPathsRef.current.add(attachmentPath);
    }
    for (const path of replacedAttachmentPaths) {
      linkedIosAttachmentPathsRef.current.delete(path);
    }
    if (replacedAttachmentPaths.length) {
      const replaced = new Set(replacedAttachmentPaths);
      setAttachments((current) => current.filter((entry) => !replaced.has(entry.path)));
    }
    setIosElementContextItems((current) => [
      {
        ...item,
        id: instanceId,
        metadata: {
          ...item.metadata,
          originalElementId: item.metadata.originalElementId ?? item.id,
          contextInstanceId: instanceId,
          ...(attachmentPath ? { attachmentPath } : {}),
        },
      },
      ...current.filter((entry) => iosContextSurface(entry) === nextSurface),
    ]);
  }, [iosElementContextItems]);

  const addAppControlContext = useCallback((item: AppControlContextItem) => {
    const latestAttachment = latestAttachmentRef.current;
    const attachmentPath = item.screenshotDataUrl
      && latestAttachment?.type === "image"
      && Date.now() - latestAttachment.addedAt < 10_000
      && !linkedAppControlAttachmentPathsRef.current.has(latestAttachment.path)
        ? latestAttachment.path
        : getAppControlContextAttachmentPath(item);
    const instanceId = createAppControlContextInstanceId(item);
    if (attachmentPath) {
      linkedAppControlAttachmentPathsRef.current.add(attachmentPath);
    }
    setAppControlContextItems((current) => [
      {
        ...item,
        id: instanceId,
        metadata: {
          ...item.metadata,
          originalElementId: item.metadata.originalElementId ?? item.id,
          contextInstanceId: instanceId,
          ...(attachmentPath ? { attachmentPath } : {}),
        },
      },
      ...current.slice(0, 4),
    ]);
  }, []);

  const addBuiltInBrowserContext = useCallback(async (rawItem: unknown) => {
    const item = normalizeBuiltInBrowserContextItem(rawItem);
    if (!item) return;
    let attachmentPath = getBuiltInBrowserContextAttachmentPath(item);
    if (item.screenshotDataUrl && !attachmentPath) {
      try {
        const saved = await window.ade.agentChat.saveTempAttachment({
          data: stripDataUrlPrefix(item.screenshotDataUrl),
          filename: "built-in-browser-selection.png",
        });
        attachmentPath = saved.path;
        addAttachment({ path: saved.path, type: inferAttachmentType(saved.path, "image/png") });
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    }

    const instanceId = createBuiltInBrowserContextInstanceId(item);
    if (attachmentPath) {
      linkedBuiltInBrowserAttachmentPathsRef.current.add(attachmentPath);
    }
    setBuiltInBrowserContextItems((current) => [
      {
        ...item,
        id: instanceId,
        metadata: {
          ...item.metadata,
          originalElementId: item.metadata.originalElementId ?? item.id,
          contextInstanceId: instanceId,
          ...(selectedSessionId ? { chatSessionId: selectedSessionId } : {}),
          ...(attachmentPath ? { attachmentPath } : {}),
        },
      },
      ...current.slice(0, 4),
    ]);
  }, [addAttachment, selectedSessionId]);

  const addMacosVmContext = useCallback((item: MacosVmContextItem) => {
    const instanceId = createMacosVmContextInstanceId(item);
    setMacosVmContextItems((current) => [
      {
        ...item,
        id: instanceId,
        metadata: {
          ...item.metadata,
          originalTargetId: item.metadata.originalTargetId ?? item.id,
          contextInstanceId: instanceId,
          ...(selectedSessionId ? { chatSessionId: selectedSessionId } : {}),
        },
      },
      ...current.filter((entry) => entry.laneId !== item.laneId),
    ]);
  }, [selectedSessionId]);

  useEffect(() => {
    const matchesThisChat = (sessionId: unknown): boolean => (
      typeof sessionId === "string" && sessionId === selectedSessionIdRef.current
    );
    const matchesThisDraft = (targetId: unknown): boolean => (
      selectedSessionIdRef.current == null
      && forceDraft
      && typeof targetId === "string"
      && targetId === draftContextTargetId
    );
    const matchesThisComposer = (detail: { sessionId?: unknown; draftTargetId?: unknown } | undefined): boolean => (
      matchesThisChat(detail?.sessionId) || matchesThisDraft(detail?.draftTargetId)
    );

    type ComposerEventDetail = { sessionId?: unknown; draftTargetId?: unknown; [key: string]: unknown };
    const composerDetail = (event: Event): ComposerEventDetail | undefined => {
      const detail = (event as CustomEvent<ComposerEventDetail>).detail;
      return matchesThisComposer(detail) ? detail : undefined;
    };

    const onAddAttachment = (event: Event) => {
      const detail = composerDetail(event);
      if (!detail) return;
      const attachment = detail.attachment as AgentChatFileRef | undefined;
      if (!attachment?.path) return;
      addAttachment(attachment);
    };
    const onInsertDraft = (event: Event) => {
      const detail = composerDetail(event);
      if (!detail || typeof detail.text !== "string") return;
      insertComposerDraft(detail.text);
    };
    const onAddIosContext = (event: Event) => {
      const detail = composerDetail(event);
      if (!detail?.item) return;
      addIosElementContext(detail.item as IosElementContextItem);
    };
    const onAddAppControlContext = (event: Event) => {
      const detail = composerDetail(event);
      if (!detail?.item) return;
      addAppControlContext(detail.item as AppControlContextItem);
    };
    const onAddBuiltInBrowserContext = (event: Event) => {
      const detail = composerDetail(event);
      if (!detail?.item) return;
      void addBuiltInBrowserContext(detail.item);
    };
    const onAddMacosVmContext = (event: Event) => {
      const detail = composerDetail(event);
      if (!detail?.item) return;
      addMacosVmContext(detail.item as MacosVmContextItem);
    };
    // Plan-panel annotation events (goal.md §10.7). The popover composes an
    // OrchestrationContextItem, dispatches `ade:agent-chat:add-plan-annotation`,
    // and the listener below merges it into the composer attachment tray via
    // the existing `mergeChatContextAttachments` flow. Pure ephemeral — no
    // persistence to the manifest in v1.
    const onAddPlanAnnotation = (event: Event) => {
      const detail = (event as CustomEvent<OrchestrationAnnotationEventDetail>).detail;
      if (!matchesThisChat(detail?.sessionId)) return;
      const rawItem = detail?.item;
      if (!isOrchestrationContextItem(rawItem)) return;
      setContextAttachments((prev) => mergeChatContextAttachments(prev, [
        makeOrchestrationAnnotationContextAttachment(rawItem),
      ]));
    };

    window.addEventListener("ade:agent-chat:add-attachment", onAddAttachment);
    window.addEventListener("ade:agent-chat:insert-draft", onInsertDraft);
    window.addEventListener("ade:agent-chat:add-ios-context", onAddIosContext);
    window.addEventListener("ade:agent-chat:add-app-control-context", onAddAppControlContext);
    window.addEventListener("ade:agent-chat:add-builtin-browser-context", onAddBuiltInBrowserContext);
    window.addEventListener("ade:agent-chat:add-macos-vm-context", onAddMacosVmContext);
    window.addEventListener("ade:agent-chat:add-plan-annotation", onAddPlanAnnotation);
    return () => {
      window.removeEventListener("ade:agent-chat:add-attachment", onAddAttachment);
      window.removeEventListener("ade:agent-chat:insert-draft", onInsertDraft);
      window.removeEventListener("ade:agent-chat:add-ios-context", onAddIosContext);
      window.removeEventListener("ade:agent-chat:add-app-control-context", onAddAppControlContext);
      window.removeEventListener("ade:agent-chat:add-builtin-browser-context", onAddBuiltInBrowserContext);
      window.removeEventListener("ade:agent-chat:add-macos-vm-context", onAddMacosVmContext);
      window.removeEventListener("ade:agent-chat:add-plan-annotation", onAddPlanAnnotation);
    };
  }, [
    addAppControlContext,
    addAttachment,
    addBuiltInBrowserContext,
    addIosElementContext,
    addMacosVmContext,
    draftContextTargetId,
    forceDraft,
    insertComposerDraft,
  ]);

  const removeAttachment = useCallback((attachmentPath: string) => {
    linkedIosAttachmentPathsRef.current.delete(attachmentPath);
    linkedAppControlAttachmentPathsRef.current.delete(attachmentPath);
    linkedBuiltInBrowserAttachmentPathsRef.current.delete(attachmentPath);
    setAttachments((prev) => prev.filter((entry) => entry.path !== attachmentPath));
    setIosElementContextItems((prev) => prev.filter((entry) => getIosContextAttachmentPath(entry) !== attachmentPath));
    setAppControlContextItems((prev) => prev.filter((entry) => getAppControlContextAttachmentPath(entry) !== attachmentPath));
    setBuiltInBrowserContextItems((prev) => prev.filter((entry) => getBuiltInBrowserContextAttachmentPath(entry) !== attachmentPath));
  }, []);

  const addContextAttachment = useCallback((attachment: AgentChatContextAttachment) => {
    setContextAttachments((prev) => mergeChatContextAttachments(prev, [attachment]));
  }, []);

  const removeContextAttachment = useCallback((key: string) => {
    setContextAttachments((prev) => removeChatContextAttachment(prev, key));
  }, []);

  const consumedInitialLinearIssueContextRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialLinearIssueContext) {
      consumedInitialLinearIssueContextRef.current = null;
      return;
    }
    const key = initialLinearIssueContext.id;
    if (consumedInitialLinearIssueContextRef.current === key) return;
    consumedInitialLinearIssueContextRef.current = key;
    setContextAttachments((prev) => mergeChatContextAttachments(prev, [
      makeLinearIssueContextAttachment(initialLinearIssueContext, initialLinearIssueContextSource),
    ]));
    onInitialLinearIssueContextConsumed?.();
  }, [initialLinearIssueContext, initialLinearIssueContextSource, onInitialLinearIssueContextConsumed]);

  const consumedInitialModelIdRef = useRef<string | null>(null);
  useEffect(() => {
    const nextModelId = initialModelId?.trim() || "";
    if (!nextModelId) {
      consumedInitialModelIdRef.current = null;
      return;
    }
    if (!preferencesReady) return;
    if (consumedInitialModelIdRef.current === nextModelId) return;
    consumedInitialModelIdRef.current = nextModelId;
    setModelId(nextModelId);
  }, [initialModelId, preferencesReady]);

  const currentNativeControls = useMemo<NativeControlState>(() => ({
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    opencodePermissionMode,
    droidPermissionMode,
    cursorModeId,
    cursorConfigValues,
  }), [
    interactionMode,
    claudePermissionMode,
    codexApprovalPolicy,
    codexSandbox,
    codexConfigSource,
    opencodePermissionMode,
    droidPermissionMode,
    cursorModeId,
    cursorConfigValues,
  ]);
  const nativeControlsRef = useRef<NativeControlState>(currentNativeControls);
  useEffect(() => {
    nativeControlsRef.current = currentNativeControls;
  }, [currentNativeControls]);

  const flushPendingComposerDraftWrite = useCallback(() => {
    if (composerDraftWriteTimerRef.current != null) {
      window.clearTimeout(composerDraftWriteTimerRef.current);
      composerDraftWriteTimerRef.current = null;
    }
    const pending = pendingComposerDraftWriteRef.current;
    pendingComposerDraftWriteRef.current = null;
    if (pending) {
      writeComposerDraftSnapshot(pending.storageKey, pending.snapshot);
    }
  }, []);

  useEffect(() => {
    return () => {
      flushPendingComposerDraftWrite();
    };
  }, [composerDraftStorageKeyValue, flushPendingComposerDraftWrite]);

  // Save/restore per-session (or per-lane draft) composer state when scope changes.
  const composerDraftTextRef = useRef(draft);
  useEffect(() => {
    composerDraftTextRef.current = draft;
  }, [draft]);
  const prevDraftKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (prevDraftKeyRef.current !== undefined) {
      draftsPerSessionRef.current.set(prevDraftKeyRef.current, composerDraftTextRef.current);
    }
    prevDraftKeyRef.current = companionStateKey;
    const saved = readLatestComposerDraftSnapshot(composerDraftStorageKeyValues, initialNativeControls);
    composerDraftHydratingRef.current = true;
    if (saved) {
      draftsPerSessionRef.current.set(companionStateKey, saved.text);
      setDraft(saved.text);
      setAttachments(saved.attachments);
      setContextAttachments(saved.contextAttachments);
      setIosElementContextItems(saved.iosContextItems);
      setAppControlContextItems(saved.appControlContextItems);
      setBuiltInBrowserContextItems(saved.builtInBrowserContextItems);
      setMacosVmContextItems(saved.macosVmContextItems);
      setDraftLaunchTargetId(saved.draftLaunchTargetId);
      if (!selectedSessionId && saved.modelId) {
        draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
        draftLaunchConfigHydratedRef.current = `${draftLaunchConfigScopeKey}:composer-draft`;
        applyLaunchConfigToComposer({
          version: 1,
          modelId: saved.modelId,
          reasoningEffort: saved.reasoningEffort,
          codexFastMode: saved.codexFastMode,
          executionMode: saved.executionMode,
          controls: saved.controls,
          updatedAt: saved.updatedAt,
        });
      }
      return;
    }
    const savedText = draftsPerSessionRef.current.get(companionStateKey) ?? "";
    setDraft(savedText);
    setAttachments([]);
    setContextAttachments([]);
    setIosElementContextItems([]);
    setAppControlContextItems([]);
    setBuiltInBrowserContextItems([]);
    setMacosVmContextItems([]);
    setDraftLaunchTargetId(null);
  }, [
    applyLaunchConfigToComposer,
    companionStateKey,
    composerDraftStorageKeyValues,
    draftLaunchConfigScopeKey,
    initialNativeControls,
    selectedSessionId,
  ]);

  useEffect(() => {
    if (composerDraftHydratingRef.current) {
      composerDraftHydratingRef.current = false;
      return;
    }
    draftsPerSessionRef.current.set(companionStateKey, draft);
    const snapshot: ComposerDraftStorageSnapshot = {
      version: 1,
      text: draft,
      modelId,
      reasoningEffort,
      codexFastMode,
      executionMode,
      controls: {
        ...currentNativeControls,
        cursorConfigValues: { ...currentNativeControls.cursorConfigValues },
      },
      attachments,
      contextAttachments,
      iosContextItems: iosElementContextItems,
      appControlContextItems,
      builtInBrowserContextItems,
      macosVmContextItems,
      draftLaunchTargetId,
      updatedAt: new Date().toISOString(),
    };
    pendingComposerDraftWriteRef.current = {
      storageKey: composerDraftStorageKeyValue,
      snapshot,
    };
    if (composerDraftWriteTimerRef.current != null) {
      window.clearTimeout(composerDraftWriteTimerRef.current);
    }
    composerDraftWriteTimerRef.current = window.setTimeout(() => {
      const pending = pendingComposerDraftWriteRef.current;
      pendingComposerDraftWriteRef.current = null;
      composerDraftWriteTimerRef.current = null;
      if (pending) {
        writeComposerDraftSnapshot(pending.storageKey, pending.snapshot);
      }
    }, COMPOSER_DRAFT_WRITE_DEBOUNCE_MS);
  }, [
    appControlContextItems,
    attachments,
    builtInBrowserContextItems,
    codexFastMode,
    companionStateKey,
    composerDraftStorageKeyValue,
    contextAttachments,
    currentNativeControls,
    draft,
    draftLaunchTargetId,
    executionMode,
    iosElementContextItems,
    macosVmContextItems,
    modelId,
    reasoningEffort,
  ]);

  useEffect(() => {
    if (!parallelChatMode) return;
    if (parallelModelSlots.length > 0) return;
    setParallelModelSlots([
      cloneParallelSlotFromComposer({
        native: currentNativeControls,
        modelId,
        reasoningEffort,
        codexFastMode,
        executionMode,
      }),
      cloneParallelSlotFromComposer({
        native: currentNativeControls,
        modelId,
        reasoningEffort,
        codexFastMode,
        executionMode,
      }),
    ]);
  }, [parallelChatMode, parallelModelSlots.length, currentNativeControls, modelId, reasoningEffort, codexFastMode, executionMode]);

  const buildNativeControlPayload = useCallback((provider: ChatRuntimeProviderKey) => {
    return {
      ...summarizeNativeControls(provider, currentNativeControls),
      ...(provider === "cursor" ? { cursorConfigValues: currentNativeControls.cursorConfigValues } : {}),
    };
  }, [currentNativeControls]);

  const buildNativeControlPayloadForSlot = useCallback((slot: ParallelModelRowState, provider: ChatRuntimeProviderKey) => {
    const native = nativeControlSliceFromParallelSlot(slot);
    return {
      ...summarizeNativeControls(provider, native),
      ...(provider === "cursor" ? { cursorConfigValues: slot.cursorConfigValues } : {}),
    };
  }, []);
  const buildModelSelectionSnapshot = useCallback((nextModelId: string) => {
    const previousDesc = prevModelDescRef.current;
    const nextDesc = resolveModelDescriptorWithRuntimeCatalog(nextModelId) ?? getModelById(nextModelId);
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
  const notifySessionCreated = useCallback((session: AgentChatSession, options?: AgentChatSessionCreatedOptions) => {
    if (!onSessionCreated) return;
    // Call synchronously so the parent's lane/session focus state setters land
    // in the same React commit as the submit handler's optimistic-message setters.
    // Deferring through a microtask races with batching and leaves the new chat
    // launched-but-not-visible until the user manually navigates.
    try {
      const result = options === undefined ? onSessionCreated(session) : onSessionCreated(session, options);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch((err) => { console.error("notifySessionCreated failed:", err); });
      }
    } catch (err) {
      console.error("notifySessionCreated failed:", err);
    }
  }, [onSessionCreated]);
  const draftLaunchTargetIsAutoCreate = draftLaunchTargetId === AUTO_CREATE_LANE_OPTION_ID;
  const launchShellForDraftLane = useCallback(async () => {
    if (!laneId || draftLaunchTargetIsAutoCreate || !onOpenShellSession || shellLaunchBusy) return;
    setShellLaunchBusy(true);
    setError(null);
    try {
      await onOpenShellSession(laneId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setShellLaunchBusy(false);
    }
  }, [draftLaunchTargetIsAutoCreate, laneId, onOpenShellSession, shellLaunchBusy]);

  const createSessionForLane = useCallback(async (
    targetLaneId: string,
    options: {
      select?: boolean;
      notify?: boolean;
      notifyOptions?: AgentChatSessionCreatedOptions;
      launchState?: DraftLaunchSnapshot;
    } = {},
  ): Promise<AgentChatSession> => {
      if (constrainedModelSelectionError) {
        throw new Error(constrainedModelSelectionError);
      }
      const launchModelId = options.launchState?.modelId ?? modelId;
      const launchReasoningEffort = options.launchState?.reasoningEffort ?? reasoningEffort;
      const launchCodexFastMode = options.launchState?.codexFastMode ?? codexFastMode;
      const launchExecutionMode = options.launchState?.executionMode ?? executionMode;
      const baseNativeControls = options.launchState?.nativeControls ?? currentNativeControls;
      const desc = resolveModelDescriptorWithRuntimeCatalog(launchModelId) ?? getModelById(launchModelId);
      const permissionDesc = getModelDescriptorForPermissionMode(launchModelId);
      const provider = resolveChatRuntimeProvider(desc);
      const model = provider === "opencode" ? launchModelId : runtimeFacingModelId(desc, launchModelId);
      const sessionProfile = resolveChatSessionProfile();
      const harnessPermissionMode = provider === "opencode"
        ? recommendedOpenCodePermissionModeForModel(permissionDesc)
        : null;
      const launchControls = harnessPermissionMode
        ? {
            ...baseNativeControls,
            opencodePermissionMode: harnessPermissionMode,
          }
        : baseNativeControls;
      const nativeControlPayload = {
        ...summarizeNativeControls(provider, launchControls),
        ...(provider === "cursor" ? { cursorConfigValues: launchControls.cursorConfigValues } : {}),
      };
      // Orchestrator-lead draft: force the interactionMode so the lead chat
      // boots with the orchestrator skill + tool gates (`goal.md` §10.1).
      const orchestratorOverrides: Partial<Parameters<typeof window.ade.agentChat.create>[0]> =
        workDraftKind === "chat-orchestrator"
          ? { interactionMode: "orchestrator-lead" as AgentChatInteractionMode }
          : {};
      const created = await window.ade.agentChat.create({
        laneId: targetLaneId,
        provider,
        model,
        modelId: launchModelId,
        sessionProfile,
        reasoningEffort: launchReasoningEffort,
        ...(modelSupportsFastMode(desc) ? { codexFastMode: launchCodexFastMode } : {}),
        ...nativeControlPayload,
        ...orchestratorOverrides,
      });
      invalidateAgentChatSessionListCache({ laneId: targetLaneId });
      // Follow-up: allocate the orchestration bundle. We do this immediately
      // so the bundle path is persisted alongside the new chat (workers will
      // pick it up from the manifest). If it fails, stop before sending the
      // first prompt so a half-created lead chat cannot start working.
      if (workDraftKind === "chat-orchestrator") {
        try {
          const runCreate = await window.ade.orchestration.runCreate({
            laneId: targetLaneId,
            leadSessionId: created.id,
          });
          // Stitch the run id into the local session summary cache so the
          // OrchestrationPanel mounts on the next render. The main process
          // persists the same fields against the chat record.
          patchSessionSummary(created.id, {
            orchestrationRunId: runCreate.runId,
            orchestrationRole: "lead",
          });
        } catch (runCreateError) {
          console.warn(
            "[AgentChatPane] orchestration.runCreate failed; lead chat created without bundle",
            runCreateError,
          );
          await window.ade.agentChat.delete({ sessionId: created.id }).catch((cleanupError: unknown) => {
            console.warn("[AgentChatPane] orchestration lead cleanup failed", cleanupError);
          });
          const message = runCreateError instanceof Error
            ? `Orchestration bundle could not be allocated: ${runCreateError.message}`
            : "Orchestration bundle could not be allocated.";
          setError(message);
          throw new Error(message);
        }
      }
      const launchConfig = buildLastLaunchConfig({
        model: created.model,
        modelId: created.modelId ?? launchModelId,
        reasoningEffort: launchReasoningEffort,
        codexFastMode: modelSupportsFastMode(desc) && launchCodexFastMode,
        executionMode: launchExecutionMode,
        permissionMode: nativeControlPayload.permissionMode,
        interactionMode: launchControls.interactionMode,
        claudePermissionMode: launchControls.claudePermissionMode,
        codexApprovalPolicy: launchControls.codexApprovalPolicy,
        codexSandbox: launchControls.codexSandbox,
        codexConfigSource: launchControls.codexConfigSource,
        opencodePermissionMode: launchControls.opencodePermissionMode,
        droidPermissionMode: launchControls.droidPermissionMode,
        cursorModeId: launchControls.cursorModeId,
        cursorConfigValues: launchControls.cursorConfigValues,
      }, initialNativeControls);
      if (launchConfig) writeLastLaunchConfig(lastLaunchConfigStorageKey, launchConfig);
      loadedHistoryRef.current.delete(created.id);
      optimisticSessionIdsRef.current.add(created.id);
      knownSessionIdsRef.current.add(created.id);
      touchSession(created.id);
      if (options.select) {
        pendingSelectedSessionIdRef.current = created.id;
        draftSelectionLockedRef.current = false;
        setSelectedSessionId(created.id);
      }
      if (desc?.isCliWrapped && (desc.family === "anthropic" || desc.family === "cursor")) {
        window.ade.agentChat.warmupModel({
          sessionId: created.id,
          modelId: launchModelId,
        }).then(() => {
          if (targetLaneId === laneId) void refreshSessions({ force: true });
        }).catch(() => { /* warmup is best-effort */ });
      }
      if (options.notify) notifySessionCreated(created, options.notifyOptions);
      if (targetLaneId === laneId) void refreshSessions({ force: true }).catch(() => {});
      return created;
  }, [codexFastMode, constrainedModelSelectionError, currentNativeControls, executionMode, initialNativeControls, laneId, lastLaunchConfigStorageKey, modelId, notifySessionCreated, patchSessionSummary, reasoningEffort, refreshSessions, touchSession, workDraftKind]);

  const createSession = useCallback(async (): Promise<string | null> => {
    if (createSessionPromiseRef.current) {
      return createSessionPromiseRef.current;
    }
    if (!laneId) return null;
    if (constrainedModelSelectionError) {
      setError(constrainedModelSelectionError);
      throw new Error(constrainedModelSelectionError);
    }
    const createPromise = createSessionForLane(laneId, { select: true, notify: true })
      .then((created) => created.id);
    createSessionPromiseRef.current = createPromise;
    try {
      return await createPromise;
    } finally {
      if (createSessionPromiseRef.current === createPromise) {
        createSessionPromiseRef.current = null;
      }
    }
  }, [constrainedModelSelectionError, createSessionForLane, laneId]);

  const buildDraftLaunchSnapshotForCurrentState = useCallback((): DraftLaunchSnapshot | null => {
    const text = draft.trim();
    const iosContextSnapshot = [...iosElementContextItems];
    const appControlContextSnapshot = [...appControlContextItems];
    const builtInBrowserContextSnapshot = [...builtInBrowserContextItems];
    const macosVmContextSnapshot = [...macosVmContextItems];
    const contextAttachmentsSnapshot = [...contextAttachments];
    const visualContextPrefix = [
      formatIosElementContextForPrompt(iosContextSnapshot),
      formatAppControlContextForPrompt(appControlContextSnapshot),
      formatBuiltInBrowserContextForPrompt(builtInBrowserContextSnapshot),
      formatMacosVmContextForPrompt(macosVmContextSnapshot),
    ].filter(Boolean).join("\n");
    const visualContextDisplayChips = [
      formatIosElementContextChipsForDisplay(iosContextSnapshot),
      formatAppControlContextChipsForDisplay(appControlContextSnapshot),
      formatBuiltInBrowserContextChipsForDisplay(builtInBrowserContextSnapshot),
      formatMacosVmContextChipsForDisplay(macosVmContextSnapshot),
    ].filter(Boolean).join(" ");
    if (
      !text.length
      && !visualContextPrefix.length
      && !contextAttachmentsSnapshot.length
      && !(isWorkCliLaunchDraft && attachments.length)
    ) {
      return null;
    }
    return {
      text,
      draft,
      modelId,
      reasoningEffort,
      codexFastMode,
      executionMode,
      interactionMode,
      nativeControls: {
        ...currentNativeControls,
        cursorConfigValues: { ...currentNativeControls.cursorConfigValues },
      },
      attachments: [...attachments],
      contextAttachments: contextAttachmentsSnapshot,
      iosContextItems: iosContextSnapshot,
      appControlContextItems: appControlContextSnapshot,
      builtInBrowserContextItems: builtInBrowserContextSnapshot,
      macosVmContextItems: macosVmContextSnapshot,
      visualContextPrefix,
      visualContextDisplayChips,
      isLiteralSlashCommand: isProviderSlashCommandInput(text),
    };
  }, [
    appControlContextItems,
    attachments,
    builtInBrowserContextItems,
    codexFastMode,
    contextAttachments,
    currentNativeControls,
    draft,
    executionMode,
    interactionMode,
    iosElementContextItems,
    isWorkCliLaunchDraft,
    macosVmContextItems,
    modelId,
    reasoningEffort,
  ]);

  const prepareDraftLaunchForSend = useCallback(async (
    snapshot: DraftLaunchSnapshot,
    targetLaneId: string,
  ): Promise<PreparedDraftLaunch> => {
    const automaticMacosVmContextPrefix = await buildAutomaticMacosVmContextForPrompt(targetLaneId, {
      promptText: snapshot.text,
    });
    const finalTextPrefix = [automaticMacosVmContextPrefix, snapshot.visualContextPrefix].filter(Boolean).join("\n");
    let finalText = finalTextPrefix ? `${finalTextPrefix}${snapshot.text}` : snapshot.text;
    if (!finalText.trim().length && snapshot.contextAttachments.length) {
      finalText = "Use the attached issue context.";
    }
    const finalDisplayText = snapshot.visualContextDisplayChips
      ? snapshot.text.length
        ? `${snapshot.visualContextDisplayChips} ${snapshot.text}`
        : snapshot.visualContextDisplayChips
      : snapshot.text.length
        ? snapshot.text
        : "Attached issue context";
    return {
      ...snapshot,
      finalText,
      finalDisplayText,
      selectedAttachments: snapshot.isLiteralSlashCommand ? [] : snapshot.attachments,
      selectedContextAttachments: snapshot.isLiteralSlashCommand ? [] : snapshot.contextAttachments,
    };
  }, []);

  const restoreDraftLaunchSnapshot = useCallback((snapshot: DraftLaunchSnapshot) => {
    setDraft((current) => {
      const snapshotDraft = snapshot.draft.trim();
      const hasCurrentDraft = current.trim().length > 0;
      let next: string;
      if (hasCurrentDraft && snapshotDraft && !current.includes(snapshot.draft)) {
        next = `${current.trimEnd()}\n\n${snapshot.draft}`;
      } else if (hasCurrentDraft) {
        next = current;
      } else {
        next = snapshot.draft;
      }
      draftsPerSessionRef.current.set(companionStateKey, next);
      return next;
    });
    setAttachments((current) => mergeAttachments(current, snapshot.attachments));
    setContextAttachments((current) => mergeChatContextAttachments(current, snapshot.contextAttachments));
    setIosElementContextItems((current) => mergeComposerItemsById(current, snapshot.iosContextItems));
    setAppControlContextItems((current) => mergeComposerItemsById(current, snapshot.appControlContextItems));
    setBuiltInBrowserContextItems((current) => mergeComposerItemsById(current, snapshot.builtInBrowserContextItems));
    setMacosVmContextItems((current) => mergeComposerItemsById(current, snapshot.macosVmContextItems));
    if (snapshot.modelId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
      draftLaunchConfigHydratedRef.current = `${draftLaunchConfigScopeKey}:restored-launch`;
      applyLaunchConfigToComposer({
        version: 1,
        modelId: snapshot.modelId,
        reasoningEffort: snapshot.reasoningEffort,
        codexFastMode: snapshot.codexFastMode,
        executionMode: snapshot.executionMode,
        controls: snapshot.nativeControls,
        updatedAt: new Date().toISOString(),
      });
    }
  }, [applyLaunchConfigToComposer, companionStateKey, draftLaunchConfigScopeKey]);

  const patchDraftLaunchJob = useCallback((jobId: string, patch: Partial<DraftLaunchJob>) => {
    setDraftLaunchJobs((current) => pruneDraftLaunchJobs(current.map((job) => (
      job.id === jobId ? { ...job, ...patch } : job
    ))));
  }, [setDraftLaunchJobs]);

  const draftLaunchJobExists = useCallback((jobId: string) => {
    return (useAppStore.getState().draftLaunchJobsByScope[draftLaunchJobsScopeKey] ?? EMPTY_DRAFT_LAUNCH_JOBS)
      .some((job) => job.id === jobId);
  }, [draftLaunchJobsScopeKey]);

  const dismissDraftLaunchJob = useCallback((jobId: string) => {
    setDraftLaunchJobs((current) => current.filter((job) => job.id !== jobId));
  }, [setDraftLaunchJobs]);

  const openLaunchedDraftSession = useCallback((launch: BackgroundLaunchNotice & { jobId?: string }) => {
    if (launch.jobId) {
      dismissDraftLaunchJob(launch.jobId);
    }
    if (projectRoot) {
      setWorkViewState(projectRoot, (prev) => ({
        ...prev,
        openItemIds: prev.openItemIds.includes(launch.sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, launch.sessionId],
        activeItemId: launch.sessionId,
        selectedItemId: launch.sessionId,
        draftKind: launch.draftKind,
        viewMode: "tabs",
      }));
      setLaneWorkViewState(projectRoot, launch.laneId, (prev) => ({
        ...prev,
        openItemIds: prev.openItemIds.includes(launch.sessionId)
          ? prev.openItemIds
          : [...prev.openItemIds, launch.sessionId],
        activeItemId: launch.sessionId,
        selectedItemId: launch.sessionId,
        draftKind: launch.draftKind,
        viewMode: "tabs",
      }));
    }
    if (suppressDraftLaunchNavigation) {
      return;
    }
    if (embeddedWorkLayout) {
      navigate(`/work?laneId=${encodeURIComponent(launch.laneId)}&sessionId=${encodeURIComponent(launch.sessionId)}`);
      return;
    }
    navigate(`/lanes?laneId=${encodeURIComponent(launch.laneId)}&sessionId=${encodeURIComponent(launch.sessionId)}&focus=single`);
  }, [
    dismissDraftLaunchJob,
    embeddedWorkLayout,
    navigate,
    projectRoot,
    setLaneWorkViewState,
    setWorkViewState,
    suppressDraftLaunchNavigation,
  ]);

  const resolveDraftLaunchLane = useCallback(async (
    snapshot: DraftLaunchSnapshot,
    onAutoCreateNameResolved?: () => void,
  ): Promise<DraftLaunchLaneTarget> => {
    if (draftLaunchTargetIsAutoCreate) {
      if (!laneId) throw new Error("Select a lane before auto-creating a new lane.");
      const primaryLane = availableLanes?.find((candidate) => candidate.laneType === "primary")
        ?? availableLanes?.find((candidate) => candidate.name.trim().toLowerCase() === "primary")
        ?? null;
      if (!primaryLane) throw new Error("Auto-create requires a primary lane.");
      const laneName = await window.ade.agentChat.suggestLaneName({
        laneId: primaryLane.id,
        prompt: buildDraftLaunchNamingSeed(snapshot),
        modelId: snapshot.modelId,
        fallbackName: createTemporaryAutoLaneName(),
      });
      onAutoCreateNameResolved?.();
      const createdLane = await window.ade.lanes.create({ name: laneName, parentLaneId: primaryLane.id });
      await refreshLanesStore().catch((refreshError: unknown) => {
        console.warn("draft launch lane refresh failed", refreshError);
      });
      return {
        laneId: createdLane.id,
        laneName: createdLane.name,
        worktreePath: createdLane.worktreePath ?? null,
        autoCreated: true,
      };
    }
    if (!laneId) throw new Error("Select a lane before launching.");
    const launchLane = lanes.find((lane) => lane.id === laneId);
    const laneName = availableLanes?.find((lane) => lane.id === laneId)?.name ?? launchLane?.name ?? laneDisplayLabel ?? laneId;
    return {
      laneId,
      laneName,
      worktreePath: launchLane?.worktreePath ?? projectRoot ?? null,
      autoCreated: false,
    };
  }, [availableLanes, draftLaunchTargetIsAutoCreate, laneDisplayLabel, laneId, lanes, projectRoot, refreshLanesStore]);

  const clearDraftLaunchComposer = useCallback((snapshot: DraftLaunchSnapshot) => {
    setDraft((current) => {
      if (current !== snapshot.draft) return current;
      draftsPerSessionRef.current.set(companionStateKey, "");
      return "";
    });
    setAttachments([]);
    setContextAttachments([]);
    setIosElementContextItems([]);
    setAppControlContextItems([]);
    setBuiltInBrowserContextItems([]);
    setMacosVmContextItems([]);
  }, [companionStateKey]);

  const cleanupDraftChatSession = useCallback(async (
    session: AgentChatSession,
    targetLane: DraftLaunchLaneTarget,
  ) => {
    await window.ade.agentChat.delete({ sessionId: session.id }).catch((cleanupError: unknown) => {
      console.warn("draft chat launch session cleanup failed", cleanupError);
    });
    loadedHistoryRef.current.delete(session.id);
    localTouchBySessionRef.current.delete(session.id);
    optimisticSessionIdsRef.current.delete(session.id);
    knownSessionIdsRef.current.delete(session.id);
    invalidateSessionListCache();
    invalidateAgentChatSessionListCache({ laneId: targetLane.laneId });
    if (targetLane.laneId === laneId) {
      await refreshSessions({ force: true }).catch(() => undefined);
    }
  }, [laneId, refreshSessions]);

  const startDraftChatLaunch = useCallback(async (
    prepared: PreparedDraftLaunch,
    targetLane: DraftLaunchLaneTarget,
  ): Promise<StartedDraftLaunch> => {
    let createdSession: AgentChatSession | null = null;
    try {
      createdSession = await createSessionForLane(targetLane.laneId, { select: false, launchState: prepared });
      touchSession(createdSession.id);
      const sendInteractionMode = createdSession.provider === "claude"
        ? createdSession.interactionMode ?? prepared.interactionMode
        : null;
      await window.ade.agentChat.send({
        sessionId: createdSession.id,
        text: prepared.finalText,
        displayText: prepared.finalDisplayText || "Selected visual app context",
        attachments: prepared.selectedAttachments,
        contextAttachments: prepared.selectedContextAttachments,
        reasoningEffort: prepared.reasoningEffort,
        executionMode: prepared.executionMode,
        interactionMode: sendInteractionMode,
        ...(createdSession.provider === "cursor" ? { runtime: "local" as const } : {}),
      });
      notifySessionCreated(createdSession, {
        activate: false,
        source: "draft-launch",
      });
      return {
        sessionId: createdSession.id,
        draftKind: "chat",
      };
    } catch (launchError) {
      if (createdSession) {
        await cleanupDraftChatSession(createdSession, targetLane);
      }
      throw launchError;
    }
  }, [
    cleanupDraftChatSession,
    createSessionForLane,
    notifySessionCreated,
    touchSession,
  ]);

  const startDraftCliLaunch = useCallback(async (
    prepared: PreparedDraftLaunch,
    targetLane: DraftLaunchLaneTarget,
    mode: DraftLaunchMode,
  ): Promise<StartedDraftLaunch> => {
    if (!onLaunchCliSession) throw new Error("CLI sessions are not available from this surface.");
    if (!prepared.modelId) throw new Error("Select a model before launching a CLI session.");
    const desc = resolveModelDescriptorWithRuntimeCatalog(prepared.modelId) ?? getModelById(prepared.modelId);
    if (!desc) throw new Error("Select a model before launching a CLI session.");
    if (desc.family === "cursor" && desc.cursorAvailability?.cli !== true) {
      throw new Error("This Cursor model is available for chat only. Choose a Cursor CLI model for a CLI session.");
    }
    const provider = desc.family === "cursor" ? "cursor" : resolveCliProviderForModel(desc) ?? "opencode";
    const runtimeModel = getRuntimeModelRefForDescriptor(desc, provider);
    const launchModel = desc.family === "cursor"
      ? resolveCursorCliModelVariant(desc, {
          reasoningEffort: prepared.reasoningEffort,
          fastMode: prepared.codexFastMode,
        })
      : runtimeModel;
    const permissionMode = cliPermissionModeFromNativeControls(provider, prepared.nativeControls);
    const cliPrompt = buildWorkCliInitialPrompt({
      text: prepared.finalText,
      attachments: prepared.selectedAttachments,
      contextAttachments: prepared.selectedContextAttachments,
    });
    if (!cliPrompt.trim().length) throw new Error("Enter a prompt or attach context before launching a CLI session.");
    const cliSessionId = provider === "claude" ? createClaudeSessionIdForCliLaunch() : undefined;
    const launch = buildTrackedCliLaunchCommand({
      provider,
      permissionMode,
      ...(cliSessionId ? { sessionId: cliSessionId } : {}),
      model: launchModel,
      reasoningEffort: prepared.reasoningEffort,
      initialPrompt: cliPrompt,
      laneWorktreePath: targetLane.worktreePath ?? projectRoot,
    });
    const codexUsesPromptArg = provider === "codex" && runtimeModel === "gpt-5.3-codex";
    const initialInput = launch.initialInput ?? (
      provider === "codex" && !codexUsesPromptArg ? cliPrompt : undefined
    );
    const initialInputDelayMs = launch.initialInputDelayMs ?? (
      initialInput && provider === "codex" && !codexUsesPromptArg ? 750 : undefined
    );
    const result = await onLaunchCliSession({
      laneId: targetLane.laneId,
      profile: provider,
      title: workCliTitleFromPrompt(prepared.text || prepared.finalDisplayText || prepared.finalText, LAUNCH_PROFILE_TITLE[provider]),
      startupCommand: launch.startupCommand,
      startupDelayMs: workCliStartupDelayMs,
      ...(launch.command !== undefined ? { command: launch.command } : {}),
      ...(launch.args !== undefined ? { args: launch.args } : {}),
      ...(initialInput !== undefined ? { initialInput } : {}),
      ...(initialInputDelayMs !== undefined ? { initialInputDelayMs } : {}),
      ...(launch.env ? { env: launch.env } : {}),
      tracked: true,
      disposition: mode,
    });
    return {
      sessionId: result.sessionId,
      draftKind: "cli",
    };
  }, [
    onLaunchCliSession,
    projectRoot,
  ]);

  const launchDraftSession = useCallback(async (kind: DraftLaunchKind, mode: DraftLaunchMode) => {
    if (parallelLaunchBusy || projectTransitionBlocksChat) {
      return;
    }
    if (kind === "chat" && (selectedSessionId || (workDraftKind !== "chat" && workDraftKind !== "chat-orchestrator"))) return;
    if (kind === "cli" && (!isWorkCliLaunchDraft || !onLaunchCliSession)) return;
    if (!modelId) {
      setError("Select a model first");
      return;
    }
    const snapshot = buildDraftLaunchSnapshotForCurrentState();
    if (!snapshot) {
      setError(kind === "cli"
        ? "Enter a prompt or attach context before launching a CLI session."
        : "Add a message before sending.");
      return;
    }
    const requestKey = draftLaunchRequestKey({
      kind,
      mode,
      autoCreate: draftLaunchTargetIsAutoCreate,
      snapshot,
    });
    if (draftLaunchInFlightKeysRef.current.has(requestKey)) {
      return;
    }
    draftLaunchInFlightKeysRef.current.add(requestKey);
    void copyPromptForLaunch(snapshot.text);

    const jobId = createDraftLaunchJobId();
    if (mode === "foreground") {
      latestForegroundDraftLaunchJobIdRef.current = jobId;
    }
    const job: DraftLaunchJob = {
      id: jobId,
      mode,
      draftKind: kind,
      status: draftLaunchTargetIsAutoCreate ? "naming-lane" : "starting-session",
      title: buildDraftLaunchJobTitle(kind, snapshot),
      laneId: null,
      laneName: null,
      sessionId: null,
      error: null,
      autoOpen: mode === "foreground",
      createdAtMs: Date.now(),
      snapshot,
    };
    setPromptSuggestion(null);
    setError(null);
    setDraftLaunchJobs((current) => pruneDraftLaunchJobs([
      job,
      ...current.map((entry) => (
        mode === "foreground" && entry.mode === "foreground"
          ? { ...entry, autoOpen: false }
          : entry
      )),
    ]));
    clearDraftLaunchComposer(snapshot);

    let targetLane: DraftLaunchLaneTarget | null = null;

    try {
      targetLane = await resolveDraftLaunchLane(snapshot, () => {
        patchDraftLaunchJob(jobId, { status: "creating-lane" });
      });
      patchDraftLaunchJob(jobId, {
        status: "starting-session",
        laneId: targetLane.laneId,
        laneName: targetLane.laneName,
      });
      const prepared = await prepareDraftLaunchForSend(snapshot, targetLane.laneId);
      patchDraftLaunchJob(jobId, {
        status: "sending-prompt",
        laneId: targetLane.laneId,
        laneName: targetLane.laneName,
      });
      const launched = kind === "chat"
        ? await startDraftChatLaunch(prepared, targetLane)
        : await startDraftCliLaunch(prepared, targetLane, mode);
      invalidateSessionListCache();
      invalidateAgentChatSessionListCache({ laneId: targetLane.laneId });
      if (launched.draftKind === "chat" && targetLane.laneId === laneId) {
        void refreshSessions({ force: true }).catch(() => {});
      }
      const launch = {
        laneId: targetLane.laneId,
        laneName: targetLane.laneName,
        sessionId: launched.sessionId,
        draftKind: launched.draftKind,
      };
      const shouldAutoOpen = mode === "foreground" && latestForegroundDraftLaunchJobIdRef.current === jobId;
      const jobStillVisible = draftLaunchJobExists(jobId);
      patchDraftLaunchJob(jobId, {
        status: "ready",
        laneId: launch.laneId,
        laneName: launch.laneName,
        sessionId: launch.sessionId,
        draftKind: launch.draftKind,
        autoOpen: false,
      });
      if (!jobStillVisible) {
        return;
      }
      if (shouldAutoOpen && paneMountedRef.current) {
        openLaunchedDraftSession({ ...launch, jobId });
      } else if (mode === "background" && paneMountedRef.current) {
        setSelectedSessionId(null);
      }
    } catch (launchError) {
      if (targetLane?.autoCreated) {
        await window.ade.lanes.delete({ laneId: targetLane.laneId, force: true }).catch((cleanupError: unknown) => {
          console.warn(`draft ${kind} launch lane cleanup failed`, cleanupError);
        });
        await refreshLanesStore().catch(() => undefined);
      }
      const message = launchError instanceof Error ? launchError.message : String(launchError);
      const jobStillVisible = draftLaunchJobExists(jobId);
      patchDraftLaunchJob(jobId, {
        status: "failed",
        laneId: targetLane?.laneId ?? null,
        laneName: targetLane?.laneName ?? null,
        error: message,
        autoOpen: false,
      });
      if (jobStillVisible && paneMountedRef.current) {
        setError(message);
      }
    } finally {
      draftLaunchInFlightKeysRef.current.delete(requestKey);
    }
  }, [
    buildDraftLaunchSnapshotForCurrentState,
    clearDraftLaunchComposer,
    draftLaunchJobExists,
    draftLaunchTargetIsAutoCreate,
    isWorkCliLaunchDraft,
    laneId,
    modelId,
    onLaunchCliSession,
    openLaunchedDraftSession,
    patchDraftLaunchJob,
    parallelLaunchBusy,
    prepareDraftLaunchForSend,
    projectTransitionBlocksChat,
    copyPromptForLaunch,
    refreshLanesStore,
    refreshSessions,
    resolveDraftLaunchLane,
    selectedSessionId,
    setDraftLaunchJobs,
    startDraftChatLaunch,
    startDraftCliLaunch,
    workDraftKind,
  ]);

  const launchDraftChat = useCallback((mode: DraftLaunchMode) => launchDraftSession("chat", mode), [launchDraftSession]);
  const launchDraftCliSession = useCallback((mode: DraftLaunchMode) => launchDraftSession("cli", mode), [launchDraftSession]);

  const handoffSession = useCallback(async (mode: "brief" | "fork" = "brief") => {
    if (!canShowHandoff || !selectedSessionId || !handoffModelId || handoffBlocked) return;
    setError(null);
    setHandoffBusy(true);
    try {
      const resolvedHandoffPermissionMode = handoffNativePermissionMode ?? selectedSession?.permissionMode;
      const result = await window.ade.agentChat.handoff({
        sourceSessionId: selectedSessionId,
        targetModelId: handoffModelId,
        mode,
        reasoningEffort: handoffReasoningEffort,
        ...(handoffTargetProvider === "codex" ? { codexFastMode: handoffCodexFastMode } : {}),
        claudePermissionMode: handoffClaudePermissionMode,
        codexApprovalPolicy: handoffCodexApprovalPolicy,
        codexSandbox: handoffCodexSandbox,
        codexConfigSource: handoffCodexConfigSource,
        opencodePermissionMode: handoffOpenCodePermissionMode,
        droidPermissionMode: handoffDroidPermissionMode,
        ...(resolvedHandoffPermissionMode != null ? { permissionMode: resolvedHandoffPermissionMode } : {}),
        cursorModeId: handoffCursorModeId,
        cursorConfigValues: handoffCursorConfigValues,
      });
      setChatActionsOpen(false);
      notifySessionCreated(result.session);
      invalidateCurrentChatSessionList();
      void refreshSessions({ force: true }).catch(() => {});
    } catch (handoffError) {
      setError(handoffError instanceof Error ? handoffError.message : String(handoffError));
    } finally {
      setHandoffBusy(false);
    }
  }, [
    canShowHandoff,
    handoffBlocked,
    handoffClaudePermissionMode,
    handoffCodexApprovalPolicy,
    handoffCodexConfigSource,
    handoffCodexFastMode,
    handoffCodexSandbox,
    handoffCursorConfigValues,
    handoffCursorModeId,
    handoffDroidPermissionMode,
    handoffModelId,
    handoffNativePermissionMode,
    handoffOpenCodePermissionMode,
    handoffReasoningEffort,
    handoffTargetProvider,
    invalidateCurrentChatSessionList,
    notifySessionCreated,
    refreshSessions,
    selectedSession?.permissionMode,
    selectedSessionId,
  ]);

  const handleDeleteSelectedChat = useCallback(() => {
    if (!selectedSessionId || !selectedSession) return;
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
        invalidateCurrentChatSessionList();
        draftsPerSessionRef.current.delete(selectedSessionId);
        localTouchBySessionRef.current.delete(selectedSessionId);
        loadedHistoryRef.current.delete(selectedSessionId);
        await refreshSessions({ force: true }).catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Delete failed: ${message}`);
      })
      .finally(() => {
        setDeletingChatSessionId((current) => (current === selectedSessionId ? null : current));
      });
  }, [invalidateCurrentChatSessionList, refreshSessions, selectedSession, selectedSessionId]);

  const handleArchiveChat = useCallback((sessionId: string) => {
    setError(null);
    void window.ade.agentChat.archive({ sessionId })
      .then(async () => {
        invalidateSessionListCache();
        invalidateCurrentChatSessionList();
        if (selectedSessionIdRef.current === sessionId) {
          setSelectedSessionId(null);
        }
        await refreshSessions({ force: true }).catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Archive failed: ${message}`);
      });
  }, [invalidateCurrentChatSessionList, refreshSessions]);

  const archiveConfirm = useConfirmDialog();
  const requestArchiveChat = useCallback(
    async (sessionId: string, title: string) => {
      const ok = await archiveConfirm.confirmAsync({
        title: `Archive "${title}"?`,
        message: "Archived chats are hidden from the active chat tabs.",
        confirmLabel: "ARCHIVE",
      });
      if (ok) handleArchiveChat(sessionId);
    },
    [archiveConfirm, handleArchiveChat],
  );

  const handleUnarchiveChat = useCallback((sessionId: string) => {
    setError(null);
    void window.ade.agentChat.unarchive({ sessionId })
      .then(async () => {
        invalidateSessionListCache();
        invalidateCurrentChatSessionList();
        await refreshSessions({ force: true }).catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Restore failed: ${message}`);
      });
  }, [invalidateCurrentChatSessionList, refreshSessions]);

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
    void createSession().catch(() => {
      eagerCreateFiredRef.current = false;
    });
  }, [preferencesReady, laneId, modelId, selectedSessionId, lockSessionId, initialSessionId, forceDraft, createSession]);

  const handleApproval = useCallback(async (
    itemId: string,
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ): Promise<boolean> => {
    if (!selectedSessionId) return false;
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
      return true;
    } catch (approvalError) {
      setRespondingApprovalIds((prev) => { const next = new Set(prev); next.delete(itemId); return next; });
      setError(approvalError instanceof Error ? approvalError.message : String(approvalError));
      return false;
    }
  }, [refreshSessions, selectedSessionId, touchSession]);

  const submit = useCallback(async () => {
    if (submitInFlightRef.current || busy || parallelLaunchBusy || projectTransitionBlocksChat) {
      if (submitInFlightRef.current) {
        setError("Still sending the previous message. Wait a moment and try again.");
      }
      return;
    }
    if (selectedSessionId) {
      const sessionPending = pendingInputsBySession[selectedSessionId] ?? [];
      const planReadyGate = sessionPending.find((entry) =>
        isOrchestrationPlanApprovalRequest(entry.request),
      ) ?? null;
      const onlyPlanReadyGatePending = sessionPending.length > 0
        && sessionPending.every((entry) => isOrchestrationPlanApprovalRequest(entry.request));
      const draftText = draft.trim();
      if (planReadyGate && onlyPlanReadyGatePending && draftText.length > 0) {
        const hasUnsupportedRevisionContext = attachments.length > 0
          || contextAttachments.length > 0
          || iosElementContextItems.length > 0
          || appControlContextItems.length > 0
          || builtInBrowserContextItems.length > 0
          || macosVmContextItems.length > 0;
        if (hasUnsupportedRevisionContext) {
          setError("Plan revisions from the ready gate are text-only. Remove attachments or click Keep planning first.");
          return;
        }
        setPromptSuggestion(null);
        void copyPromptForLaunch(draftText);
        const resolved = await handleApproval(planReadyGate.itemId, "decline", draftText);
        if (resolved) setDraft("");
        return;
      }
      const hasBlockingPending = sessionPending.some((entry) => entry.request.blocking);
      if (hasBlockingPending || selectedSession?.awaitingInput === true) {
        setError("Answer or decline the pending request before sending another message.");
        return;
      }
    }
    setPromptSuggestion(null);

    const isParallelLaunch =
      !lockSessionId
      && !initialSessionId
      && forceDraft
      && embeddedWorkLayout
      && parallelChatMode
      && selectedSessionId == null;

    if (isParallelLaunch) {
      const text = draft.trim();
      if ((!text.length && attachments.length === 0 && contextAttachments.length === 0) || !laneId || !projectRoot) return;
      if (parallelModelSlots.length < 2) {
        setError("Add at least two models for a parallel launch.");
        return;
      }
      const emptySlot = parallelModelSlots.find(s => !s.modelId?.trim());
      if (emptySlot) {
        setError("All parallel lanes must have a model selected.");
        return;
      }
      if (modelSelectionConstrained) {
        if (!effectiveAvailableModelIds.length) {
          setError("No models are available for this chat surface.");
          return;
        }
        const unavailableSlot = parallelModelSlots.find((slot) => !effectiveAvailableModelIds.includes(slot.modelId));
        if (unavailableSlot) {
          setError("Each parallel lane must use an available model for this chat surface.");
          return;
        }
      }
      const modelKeys = parallelModelSlots.map((s) => s.modelId);
      if (new Set(modelKeys).size !== modelKeys.length) {
        setError("Each parallel lane needs a different model.");
        return;
      }
      if (attachments.length > PARALLEL_CHAT_MAX_ATTACHMENTS) {
        setError(`Parallel launch allows at most ${PARALLEL_CHAT_MAX_ATTACHMENTS} attachments. Remove some files or send in batches.`);
        return;
      }
      void copyPromptForLaunch(text);

      const draftSnapshot = draft;
      const attachmentsSnapshot = [...attachments];
      const contextAttachmentsSnapshot = [...contextAttachments];
      submitInFlightRef.current = true;
      setParallelLaunchBusy(true);
      setParallelLaunchStatus("Naming lanes…");
      setError(null);
      const createdLaneIds: string[] = [];
      const sentLaneIds: string[] = [];
      const sessionByLane = new Map<string, string>();
      try {
        let namingSeed = text;
        if (!text.length && (attachmentsSnapshot.length || contextAttachmentsSnapshot.length)) {
          const imageCount = attachmentsSnapshot.filter((a) => a.type === "image").length;
          const fileCount = attachmentsSnapshot.filter((a) => a.type === "file").length;
          const issueCount = contextAttachmentsSnapshot.filter((a) => a.type === "linear_issue").length;
          namingSeed = [
            "Parallel attachment task",
            imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
            fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
            issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : null,
          ].filter(Boolean).join(" · ");
        }
        const baseName = await window.ade.agentChat.suggestLaneName({
          laneId,
          prompt: namingSeed,
          modelId: parallelModelSlots[0]!.modelId,
          fallbackName: createTemporaryAutoLaneName(),
        });
        setParallelLaunchStatus(`Creating ${parallelModelSlots.length} child lanes…`);

        for (const slot of parallelModelSlots) {
          const desc = getModelById(slot.modelId);
          const suffix = parallelLaneModelSuffix(desc);
          const laneName = `${baseName}-${suffix}`;
          const childLane = await window.ade.lanes.createChild({ parentLaneId: laneId, name: laneName });
          createdLaneIds.push(childLane.id);
          await persistParallelLaunchState(buildParallelLaunchState({
            parentLaneId: laneId,
            createdLaneIds,
            sentLaneIds,
            status: "creating_lanes",
          }));
          const provider = resolveChatRuntimeProvider(desc);
          const model = provider === "opencode" ? slot.modelId : runtimeFacingModelId(desc, slot.modelId);
          const created = await window.ade.agentChat.create({
            laneId: childLane.id,
            provider,
            model,
            modelId: slot.modelId,
            sessionProfile: resolveChatSessionProfile(),
            reasoningEffort: slot.reasoningEffort,
            ...(modelSupportsFastMode(desc) ? { codexFastMode: slot.codexFastMode } : {}),
            ...buildNativeControlPayloadForSlot(slot, provider),
          });
          sessionByLane.set(childLane.id, created.id);
        }

        await refreshLanesStore();

        const { sendText, displayText: displayForSend } = buildParallelLaunchPrompt({
          text,
          attachmentCount: attachmentsSnapshot.length,
          contextAttachmentCount: contextAttachmentsSnapshot.length,
        });

        setParallelLaunchStatus("Sending prompt to each lane…");
        await persistParallelLaunchState(buildParallelLaunchState({
          parentLaneId: laneId,
          createdLaneIds,
          sentLaneIds,
          status: "sending",
        }));
        for (let idx = 0; idx < parallelModelSlots.length; idx += 1) {
          const slot = parallelModelSlots[idx]!;
          const childLaneId = createdLaneIds[idx];
          const sessionId = childLaneId ? sessionByLane.get(childLaneId) : undefined;
          if (!sessionId) continue;
          const desc = getModelById(slot.modelId);
          const provider = resolveChatRuntimeProvider(desc);
          const sendPayload = {
            sessionId,
            text: sendText,
            displayText: displayForSend,
            attachments: attachmentsSnapshot,
            contextAttachments: contextAttachmentsSnapshot,
            reasoningEffort: slot.reasoningEffort,
            executionMode: slot.executionMode,
            interactionMode: provider === "claude" ? slot.interactionMode : null,
          };
          try {
            await window.ade.agentChat.send(sendPayload);
          } catch (sendError) {
            if (isTurnAlreadyActiveError(sendError)) {
              try {
                await window.ade.agentChat.steer({
                  sessionId,
                  text: sendText,
                  ...(attachmentsSnapshot.length ? { attachments: attachmentsSnapshot } : {}),
                  ...(contextAttachmentsSnapshot.length ? { contextAttachments: contextAttachmentsSnapshot } : {}),
                });
              } catch (steerError) {
                if (!isNoActiveTurnToSteerError(steerError)) throw steerError;
                await window.ade.agentChat.send(sendPayload);
              }
            } else {
              throw sendError;
            }
          }
          sentLaneIds.push(childLaneId);
          await persistParallelLaunchState(buildParallelLaunchState({
            parentLaneId: laneId,
            createdLaneIds,
            sentLaneIds,
            status: sentLaneIds.length >= createdLaneIds.length ? "completed" : "sending",
          }));
          if (desc?.isCliWrapped && (desc.family === "anthropic" || desc.family === "cursor")) {
            window.ade.agentChat.warmupModel({ sessionId, modelId: slot.modelId }).catch(() => {});
          }
        }

        setWorkViewState(projectRoot, (prev) => {
          let nextOpen = [...prev.openItemIds];
          for (const sid of sessionByLane.values()) {
            if (!nextOpen.includes(sid)) nextOpen.push(sid);
          }
          return { ...prev, openItemIds: nextOpen };
        });
        for (const [childLaneId, sid] of sessionByLane) {
          setLaneWorkViewState(projectRoot, childLaneId, {
            activeItemId: sid,
            selectedItemId: sid,
            draftKind: "chat",
            viewMode: "tabs",
          });
        }

        setDraft("");
        setAttachments([]);
        setContextAttachments([]);
        setParallelChatMode(false);
        setParallelModelSlots([]);
        setParallelConfiguringIndex(null);
        await persistParallelLaunchState(null);

        const q = new URLSearchParams();
        q.set("laneIds", createdLaneIds.join(","));
        q.set("workFocus", "1");
        navigate(`/lanes?${q.toString()}`);
      } catch (submitError) {
        setParallelLaunchStatus(createdLaneIds.length > 0 ? "Cleaning up child lanes…" : null);
        const cleanupIssues = await cleanupTransientParallelLaunchLanes({
          laneIds: createdLaneIds,
          deleteLane: (args) => window.ade.lanes.delete(args),
          refreshLanes: refreshLanesStore,
          onCleanupError: logParallelLaunchCleanupError,
        });
        const message = submitError instanceof Error ? submitError.message : String(submitError);
        if (cleanupIssues.length === 0) {
          await persistParallelLaunchState(null);
        } else {
          await persistParallelLaunchState(buildParallelLaunchState({
            parentLaneId: laneId,
            createdLaneIds,
            sentLaneIds,
            status: "cleanup_pending",
            lastError: message,
          }));
        }
        setDraft((current) => (current.trim().length ? current : draftSnapshot));
        setAttachments((current) => (current.length ? current : attachmentsSnapshot));
        setContextAttachments((current) => (current.length ? current : contextAttachmentsSnapshot));
        setError(formatParallelLaunchFailureMessage({
          launchError: message,
          cleanupIssues,
        }));
      } finally {
        submitInFlightRef.current = false;
        setParallelLaunchBusy(false);
        setParallelLaunchStatus(null);
      }
      return;
    }

    if (isWorkCliLaunchDraft) {
      await launchDraftCliSession("foreground");
      return;
    }

    if (constrainedModelSelectionError) {
      setError(constrainedModelSelectionError);
      return;
    }
    if (!modelId) {
      setError("Select a model first");
      return;
    }

    if (draftLaunchTargetIsAutoCreate && selectedSessionId == null && workDraftKind === "chat") {
      await launchDraftChat("foreground");
      return;
    }

    if (
      forceDraft
      && embeddedWorkLayout
      && workDraftKind === "chat"
      && selectedSessionId == null
      && !lockSessionId
      && !draftLaunchTargetIsAutoCreate
    ) {
      await launchDraftChat("foreground");
      return;
    }
    const text = draft.trim();
    const iosContextSnapshot = [...iosElementContextItems];
    const appControlContextSnapshot = [...appControlContextItems];
    const builtInBrowserContextSnapshot = [...builtInBrowserContextItems];
    const macosVmContextSnapshot = [...macosVmContextItems];
    const contextAttachmentsSnapshot = [...contextAttachments];
    const iosContextPrefix = formatIosElementContextForPrompt(iosContextSnapshot);
    const appControlContextPrefix = formatAppControlContextForPrompt(appControlContextSnapshot);
    const builtInBrowserContextPrefix = formatBuiltInBrowserContextForPrompt(builtInBrowserContextSnapshot);
    const macosVmContextPrefix = formatMacosVmContextForPrompt(macosVmContextSnapshot);
    const iosContextDisplayChips = formatIosElementContextChipsForDisplay(iosContextSnapshot);
    const appControlContextDisplayChips = formatAppControlContextChipsForDisplay(appControlContextSnapshot);
    const builtInBrowserContextDisplayChips = formatBuiltInBrowserContextChipsForDisplay(builtInBrowserContextSnapshot);
    const macosVmContextDisplayChips = formatMacosVmContextChipsForDisplay(macosVmContextSnapshot);
    const visualContextPrefix = [iosContextPrefix, appControlContextPrefix, builtInBrowserContextPrefix, macosVmContextPrefix].filter(Boolean).join("\n");
    const visualContextDisplayChips = [iosContextDisplayChips, appControlContextDisplayChips, builtInBrowserContextDisplayChips, macosVmContextDisplayChips].filter(Boolean).join(" ");
    if (
      (!text.length && !visualContextPrefix.length && !contextAttachmentsSnapshot.length && !(isWorkCliLaunchDraft && attachments.length))
      || !laneId
    ) return;
    const pendingNativeControlUpdate = pendingNativeControlUpdateRef.current;
    if (selectedSessionId && pendingNativeControlUpdate?.sessionId === selectedSessionId) {
      try {
        await pendingNativeControlUpdate.promise;
      } catch {
        return;
      }
    }
    const pendingCodexFastModeUpdate = pendingCodexFastModeUpdateRef.current;
    if (selectedSessionId && pendingCodexFastModeUpdate?.sessionId === selectedSessionId) {
      try {
        await pendingCodexFastModeUpdate.promise;
      } catch {
        return;
      }
    }
    void copyPromptForLaunch(text);
    if (
      text === "/context"
      && selectedSessionId
      && sessionProvider === "claude"
      && !attachments.length
      && !contextAttachmentsSnapshot.length
      && !visualContextPrefix.length
    ) {
      setBusy(true);
      setError(null);
      setDraft("");
      draftsPerSessionRef.current.delete(selectedSessionId);
      try {
        touchSession(selectedSessionId);
        await window.ade.agentChat.getContextUsage({ sessionId: selectedSessionId });
      } catch (contextError) {
        setDraft((current) => (current.trim().length ? current : draft));
        setError(contextError instanceof Error ? contextError.message : String(contextError));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (
      /^\/output-style(?:\s+[\s\S]+)?$/i.test(text)
      && selectedSessionId
      && sessionProvider === "claude"
      && !attachments.length
      && !contextAttachmentsSnapshot.length
      && !visualContextPrefix.length
    ) {
      setBusy(true);
      setError(null);
      setDraft("");
      draftsPerSessionRef.current.delete(selectedSessionId);
      try {
        touchSession(selectedSessionId);
        await window.ade.agentChat.send({
          sessionId: selectedSessionId,
          text,
          displayText: text,
        });
        void refreshSessions().catch(() => {});
      } catch (outputStyleError) {
        setDraft((current) => (current.trim().length ? current : draft));
        setError(outputStyleError instanceof Error ? outputStyleError.message : String(outputStyleError));
      } finally {
        setBusy(false);
      }
      return;
    }
    const draftSnapshot = draft;
    const attachmentsSnapshot = attachments;
    const isLiteralSlashCommand = isProviderSlashCommandInput(text);
    const isCodexGoalSlashCommand = sessionProvider === "codex" && isCodexGoalSlashInput(text);
    const suppressOptimisticOutgoing = isCodexGoalSlashCommand;
    const deferComposerClear = selectedSessionId == null;

    submitInFlightRef.current = true;
    setBusy(true);
    setError(null);
    if (!deferComposerClear) {
      setDraft("");
      draftsPerSessionRef.current.delete(selectedSessionId);
      setAttachments([]);
      setContextAttachments([]);
    }

    // Show the optimistic bubble immediately when we already have a session.
    // Awaiting the macOS VM IPC and any session-create roundtrip before this
    // setter delays the bubble by hundreds of ms on a typical send.
    const selectedAttachmentsForOptimistic = isLiteralSlashCommand ? [] : attachmentsSnapshot;
    const selectedContextAttachmentsForOptimistic = isLiteralSlashCommand ? [] : contextAttachmentsSnapshot;
    const optimisticDisplayText = visualContextDisplayChips
      ? text.length
        ? `${visualContextDisplayChips} ${text}`
        : visualContextDisplayChips
      : text.length
        ? text
        : contextAttachmentsSnapshot.length
          ? "Attached issue context"
          : text;
    if (selectedSessionId && !turnActiveBySession[selectedSessionId] && !suppressOptimisticOutgoing) {
      setOptimisticOutgoingMessageSynced({
        sessionId: selectedSessionId,
        envelope: {
          sessionId: selectedSessionId,
          timestamp: new Date().toISOString(),
          event: {
            type: "user_message",
            text: optimisticDisplayText,
            ...(selectedAttachmentsForOptimistic.length ? { attachments: selectedAttachmentsForOptimistic } : {}),
            ...(selectedContextAttachmentsForOptimistic.length ? { contextAttachments: selectedContextAttachmentsForOptimistic } : {}),
            deliveryState: "queued",
          },
        },
      });
    }

    try {
      const automaticMacosVmContextPrefix = await buildAutomaticMacosVmContextForPrompt(laneId, {
        promptText: text,
      });
      let justCreatedSession = false;
      const finalTextPrefix = [automaticMacosVmContextPrefix, visualContextPrefix].filter(Boolean).join("\n");
      let finalText = finalTextPrefix ? `${finalTextPrefix}${text}` : text;
      if (!finalText.trim().length && contextAttachmentsSnapshot.length) {
        finalText = "Use the attached issue context.";
      }
      const finalDisplayText = visualContextDisplayChips
        ? text.length
          ? `${visualContextDisplayChips} ${text}`
          : visualContextDisplayChips
        : text.length
          ? text
          : "Attached issue context";

      let sessionId = selectedSessionId;
      const shouldPromoteLightSession = shouldPromoteSessionForComputerUse(selectedSession);
      const selectedModelChanged =
        Boolean(selectedSessionId)
        && Boolean(selectedSessionModelId)
        && selectedSessionModelId !== modelId;
      const selectedCodexFastModeChanged =
        Boolean(selectedSessionId)
        && selectedSession?.provider === "codex"
        && (selectedSession.codexFastMode === true) !== codexFastMode;
      const selectedAttachments = isLiteralSlashCommand ? [] : attachmentsSnapshot;
      const selectedContextAttachments = isLiteralSlashCommand ? [] : contextAttachmentsSnapshot;
      const optimisticEnvelope = (nextSessionId: string): AgentChatEventEnvelope => ({
        sessionId: nextSessionId,
        timestamp: new Date().toISOString(),
        event: {
          type: "user_message",
          text: finalDisplayText || finalText,
          ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
          ...(selectedContextAttachments.length ? { contextAttachments: selectedContextAttachments } : {}),
          deliveryState: "queued",
        },
      });
      const setOptimisticIfAllowed = (nextSessionId: string) => {
        if (suppressOptimisticOutgoing) return;
        setOptimisticOutgoingMessageSynced({ sessionId: nextSessionId, envelope: optimisticEnvelope(nextSessionId) });
      };

      if (sessionId && !turnActive && (
        selectedModelChanged
        || selectedCodexFastModeChanged
        || hasComputerUseSelectionChanged
        || shouldPromoteLightSession
      )) {
        setOptimisticIfAllowed(sessionId);
        const desc = resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId);
        const provider = resolveChatRuntimeProvider(desc);
        await window.ade.agentChat.updateSession({
          sessionId,
          modelId,
          reasoningEffort,
          ...(modelSupportsFastMode(desc) ? { codexFastMode } : {}),
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
        setOptimisticIfAllowed(sessionId);
      }
      if (!sessionId) {
        throw new Error("Unable to create chat session.");
      }

      if (deferComposerClear) {
        setDraft("");
        draftsPerSessionRef.current.delete(sessionId);
        setAttachments([]);
        setContextAttachments([]);
      }

      touchSession(sessionId);
      patchSessionSummary(sessionId, {
        status: "active",
        idleSinceAt: null,
        awaitingInput: false,
        lastActivityAt: new Date().toISOString(),
      });

      const steerMessage = async () => {
        await window.ade.agentChat.steer({
          sessionId,
          text: finalText,
          ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
          ...(selectedContextAttachments.length ? { contextAttachments: selectedContextAttachments } : {}),
        });
      };

      const sendMessageOrSteerIfBusy = async (retryOnStaleSteer = true) => {
        try {
          setOptimisticIfAllowed(sessionId);
          const sendInteractionMode: AgentChatInteractionMode | null =
            sessionProvider === "claude"
              ? (
                workDraftKind === "chat-orchestrator" || selectedSession?.interactionMode === "orchestrator-lead"
                  ? "orchestrator-lead"
                  : interactionMode
              )
              : null;
          await window.ade.agentChat.send({
            sessionId,
            text: finalText,
            displayText: finalDisplayText || "Selected visual app context",
            attachments: selectedAttachments,
            contextAttachments: selectedContextAttachments,
            reasoningEffort,
            executionMode: launchModeEditable ? executionMode : null,
            interactionMode: sendInteractionMode,
            ...(sessionProvider === "cursor" ? { runtime: cursorRuntime } : {}),
          });
        } catch (sendError) {
          // Race condition: the turn may have started between our state check
          // and the backend call. If so, automatically fall back to steer
          // instead of surfacing a confusing error to the user.
          if (!isCodexGoalSlashCommand && isTurnAlreadyActiveError(sendError)) {
            try {
              await steerMessage();
            } catch (steerError) {
              if (!isNoActiveTurnToSteerError(steerError) || !retryOnStaleSteer) throw steerError;
              setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
              await sendMessageOrSteerIfBusy(false);
            }
          } else {
            throw sendError;
          }
        }
      };

      if (turnActiveBySession[sessionId] && !isCodexGoalSlashCommand) {
        setOptimisticOutgoingMessageSynced(null);
        try {
          await steerMessage();
        } catch (steerError) {
          if (!isNoActiveTurnToSteerError(steerError)) throw steerError;
          setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
          await sendMessageOrSteerIfBusy();
        }
      } else {
        await sendMessageOrSteerIfBusy();
      }
      // Skip refresh when we just created the session — createSession already triggered one.
      // A redundant refresh here causes flicker as it re-resolves session selection.
      if (!justCreatedSession) {
        await refreshSessions().catch(() => {});
      }
      setIosElementContextItems([]);
      setAppControlContextItems([]);
      setBuiltInBrowserContextItems([]);
      setMacosVmContextItems([]);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setDraft((current) => (current.trim().length ? current : draftSnapshot));
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setContextAttachments((current) => (current.length ? current : contextAttachmentsSnapshot));
      setIosElementContextItems((current) => (current.length ? current : iosContextSnapshot));
      setAppControlContextItems((current) => (current.length ? current : appControlContextSnapshot));
      setBuiltInBrowserContextItems((current) => (current.length ? current : builtInBrowserContextSnapshot));
      setMacosVmContextItems((current) => (current.length ? current : macosVmContextSnapshot));
      setOptimisticOutgoingMessageSynced(null);
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
    codexFastMode,
    constrainedModelSelectionError,
    copyPromptForLaunch,
    createSession,
    currentNativeControls,
    contextAttachments,
    draft,
    draftLaunchTargetIsAutoCreate,
    effectiveAvailableModelIds,
    executionMode,
    handleApproval,
    hasComputerUseSelectionChanged,
    interactionMode,
    isWorkCliLaunchDraft,
    laneId,
    launchDraftChat,
    launchDraftCliSession,
    launchModeEditable,
    modelSelectionConstrained,
    modelId,
    patchSessionSummary,
    projectTransitionBlocksChat,
    reasoningEffort,
    pendingInputsBySession,
    refreshAvailableModels,
    refreshSessions,
    selectedSession,
    selectedSessionId,
    selectedSessionModelId,
    setOptimisticOutgoingMessageSynced,
    sessionProvider,
    cursorRuntime,
    touchSession,
    turnActive,
    turnActiveBySession,
    parallelLaunchBusy,
    parallelChatMode,
    parallelModelSlots,
    lockSessionId,
    initialSessionId,
    forceDraft,
    embeddedWorkLayout,
    lastLaunchConfigStorageKey,
    projectRoot,
    navigate,
    buildNativeControlPayloadForSlot,
    refreshLanesStore,
    persistParallelLaunchState,
    setWorkViewState,
    setLaneWorkViewState,
    iosElementContextItems,
    appControlContextItems,
    builtInBrowserContextItems,
    macosVmContextItems,
    workDraftKind,
  ]);

  const openRewindConfirmDialog = useCallback((state: RewindFilesConfirmDialogState): Promise<boolean> => {
    rewindConfirmResolveRef.current?.(false);
    return new Promise<boolean>((resolve) => {
      rewindConfirmResolveRef.current = resolve;
      setRewindConfirmDialog(state);
    });
  }, []);

  const closeRewindConfirmDialog = useCallback(() => {
    rewindConfirmResolveRef.current?.(false);
    rewindConfirmResolveRef.current = null;
    setRewindConfirmDialog(null);
  }, []);

  const confirmRewindDialog = useCallback(() => {
    rewindConfirmResolveRef.current?.(true);
    rewindConfirmResolveRef.current = null;
    setRewindConfirmDialog(null);
  }, []);

  const rewindFilesFromMessage = useCallback(async (request: { messageId: string; timestamp: string; text: string }) => {
    if (!selectedSessionId) return;
    setBusy(true);
    setError(null);
    try {
      const preview = await window.ade.agentChat.rewindFiles({
        sessionId: selectedSessionId,
        userMessageId: request.messageId,
        dryRun: true,
      });
      if (!preview.canRewind) {
        setError(preview.error ?? "No file checkpoint is available for that message.");
        return;
      }
      const rewindSummaries = deriveRewindDiffSummaries(selectedEvents, request);
      const files = buildRewindPreviewFiles(preview, rewindSummaries);
      setBusy(false);
      const confirmed = await openRewindConfirmDialog({
        request,
        preview,
        files,
      });
      if (!confirmed) return;
      setBusy(true);
      const result = await window.ade.agentChat.rewindFiles({
        sessionId: selectedSessionId,
        userMessageId: request.messageId,
        dryRun: false,
      });
      if (!result.canRewind) {
        setError(result.error ?? "File rewind failed.");
        return;
      }
      await refreshSessions().catch(() => {});
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }, [openRewindConfirmDialog, refreshSessions, selectedEvents, selectedSessionId]);

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
    if (!selectedSessionId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
    }

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
    setDroidPermissionMode(nextControls.droidPermissionMode);
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

    const previousUpdate = pendingNativeControlUpdateRef.current?.sessionId === selectedSessionId
      ? pendingNativeControlUpdateRef.current.promise
      : null;
    const updateId = ++nativeControlUpdateCounterRef.current;

    const updatePromise = (async () => {
      if (previousUpdate) {
        // Prior mutation already surfaced any error; wait for it to settle so the
        // latest picker state still gets pushed to the backend.
        await previousUpdate.catch(() => {});
      }

      try {
        const updatedSession = await window.ade.agentChat.updateSession({
          sessionId: selectedSessionId,
          ...nextSummary,
        });
        patchSessionSummary(selectedSessionId, {
          permissionMode: updatedSession.permissionMode,
          interactionMode: updatedSession.interactionMode ?? null,
          claudePermissionMode: updatedSession.claudePermissionMode,
          codexApprovalPolicy: updatedSession.codexApprovalPolicy,
          codexSandbox: updatedSession.codexSandbox,
          codexConfigSource: updatedSession.codexConfigSource,
          opencodePermissionMode: updatedSession.opencodePermissionMode,
          droidPermissionMode: updatedSession.droidPermissionMode,
          cursorModeId: updatedSession.cursorModeId,
          cursorModeSnapshot: updatedSession.cursorModeSnapshot,
        });
        void refreshSessions().catch(() => {});
      } catch (err) {
        void refreshSessions().catch(() => {});
        setError(err instanceof Error ? err.message : String(err));
        throw err;
      } finally {
        const pending = pendingNativeControlUpdateRef.current;
        if (pending?.sessionId === selectedSessionId && pending.updateId === updateId) {
          pendingNativeControlUpdateRef.current = null;
        }
        if (isPersistentIdentitySurface) {
          setSessionMutationKind(null);
        }
      }
    })();

    pendingNativeControlUpdateRef.current = {
      sessionId: selectedSessionId,
      updateId,
      promise: updatePromise,
    };

    await updatePromise;
  }, [
    draftLaunchConfigScopeKey,
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

  const handleReasoningEffortChange = useCallback((nextReasoningEffort: string | null) => {
    const previousReasoningEffort = reasoningEffort;
    if (!selectedSessionId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
    }
    setReasoningEffort(nextReasoningEffort);
    if (!selectedSessionId) return;
    if (isPersistentIdentitySurface && sessionMutationKind) return;

    const seq = ++reasoningEffortUpdateCounterRef.current;
    const targetSessionId = selectedSessionId;
    patchSessionSummary(targetSessionId, { reasoningEffort: nextReasoningEffort });
    void window.ade.agentChat.updateSession({
      sessionId: targetSessionId,
      reasoningEffort: nextReasoningEffort,
    }).then((updatedSession) => {
      if (seq !== reasoningEffortUpdateCounterRef.current) return;
      const reconciled = updatedSession.reasoningEffort ?? null;
      patchSessionSummary(targetSessionId, { reasoningEffort: reconciled });
      if (selectedSessionIdRef.current === targetSessionId) {
        setReasoningEffort(reconciled);
      }
      void refreshSessions().catch(() => {});
    }).catch((err) => {
      if (seq === reasoningEffortUpdateCounterRef.current
        && selectedSessionIdRef.current === targetSessionId) {
        setReasoningEffort(previousReasoningEffort);
        patchSessionSummary(targetSessionId, { reasoningEffort: previousReasoningEffort });
      }
      void refreshSessions().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
    });
  }, [
    draftLaunchConfigScopeKey,
    isPersistentIdentitySurface,
    patchSessionSummary,
    reasoningEffort,
    refreshSessions,
    selectedSessionId,
    sessionMutationKind,
  ]);

  const handleCodexFastModeChange = useCallback((enabled: boolean) => {
    const previousFastMode = codexFastMode;
    if (!selectedSessionId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
    }
    setCodexFastMode(enabled);
    if (!selectedSessionId) return;
    if (isPersistentIdentitySurface && sessionMutationKind) return;

    const updateId = ++codexFastModeUpdateCounterRef.current;
    const targetSessionId = selectedSessionId;
    patchSessionSummary(targetSessionId, { codexFastMode: enabled });
    const updatePromise = window.ade.agentChat.updateSession({
      sessionId: targetSessionId,
      codexFastMode: enabled,
    }).then((updatedSession) => {
      if (updateId !== codexFastModeUpdateCounterRef.current) return;
      const reconciled = updatedSession.codexFastMode === true;
      patchSessionSummary(targetSessionId, { codexFastMode: reconciled });
      if (selectedSessionIdRef.current === targetSessionId) {
        setCodexFastMode(reconciled);
      }
      void refreshSessions().catch(() => {});
    }).catch((err) => {
      if (updateId === codexFastModeUpdateCounterRef.current
        && selectedSessionIdRef.current === targetSessionId) {
        setCodexFastMode(previousFastMode);
        patchSessionSummary(targetSessionId, { codexFastMode: previousFastMode });
      }
      void refreshSessions().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }).finally(() => {
      const pending = pendingCodexFastModeUpdateRef.current;
      if (pending?.sessionId === targetSessionId && pending.updateId === updateId) {
        pendingCodexFastModeUpdateRef.current = null;
      }
    });
    pendingCodexFastModeUpdateRef.current = {
      sessionId: targetSessionId,
      updateId,
      promise: updatePromise,
    };
    void updatePromise.catch(() => {});
  }, [
    codexFastMode,
    draftLaunchConfigScopeKey,
    isPersistentIdentitySurface,
    patchSessionSummary,
    refreshSessions,
    selectedSessionId,
    sessionMutationKind,
  ]);

  const handleExecutionModeChange = useCallback((nextExecutionMode: AgentChatExecutionMode) => {
    if (!selectedSessionId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
    }
    setExecutionMode(nextExecutionMode);
  }, [draftLaunchConfigScopeKey, selectedSessionId]);

  const handleComputerUsePolicyChange = useCallback(async (_nextPolicy: unknown) => {
    // Computer-use policy gating has been removed; this handler is a no-op retained for UI compat.
  }, []);

  const embedDraft = embeddedWorkLayout && forceDraft;
  const compactShell = embedDraft || layoutVariant === "grid-tile";
  const isEmptyState = !selectedSessionId;
  const showDraftLaunchControls =
    showWorkspaceChrome
    && selectedSessionId == null
    && !lockSessionId
    && !initialSessionId
    && (workDraftKind === "chat" || isWorkCliLaunchDraft);
  const draftLaneSelectorLanes = useMemo(
    () => showDraftLaunchControls && availableLanes
      ? [AUTO_CREATE_LANE_OPTION, ...availableLanes]
      : (availableLanes ?? []),
    [availableLanes, showDraftLaunchControls],
  );
  const primaryDraftLane = useMemo(() => (
    availableLanes?.find((candidate) => candidate.laneType === "primary")
      ?? availableLanes?.find((candidate) => candidate.name.trim().toLowerCase() === "primary")
      ?? null
  ), [availableLanes]);
  const autoCreateToolsLane = primaryDraftLane ?? availableLanes?.[0] ?? null;
  const draftLaneSelectorValue = draftLaunchTargetIsAutoCreate ? AUTO_CREATE_LANE_OPTION_ID : (laneId ?? "");
  const handleDraftLaneSelectionChange = useCallback((nextLaneId: string) => {
    if (nextLaneId === AUTO_CREATE_LANE_OPTION_ID) {
      setDraftLaunchTargetId(AUTO_CREATE_LANE_OPTION_ID);
      if (autoCreateToolsLane) onLaneChange?.(autoCreateToolsLane.id);
      return;
    }
    setDraftLaunchTargetId(null);
    onLaneChange?.(nextLaneId);
  }, [autoCreateToolsLane, onLaneChange]);

  useEffect(() => {
    if (!showDraftLaunchControls && draftLaunchTargetId) {
      setDraftLaunchTargetId(null);
    }
  }, [draftLaunchTargetId, showDraftLaunchControls]);

  if (!laneId) {
    return (
      <ChatSurfaceShell
        mode={surfaceMode}
        accentColor={presentation?.accentColor}
        contentScale={1}
        chromeTint={chatChromeTint}
        shellGeometry={chatShellGeometry}
      >
        <div
          data-chat-appearance-root
          style={chatAppearanceRootStyle}
          className="flex h-full items-center justify-center"
        >
          <span className="font-sans text-[length:calc(var(--chat-font-size)*12/14)] text-muted-fg/30">
            Select a lane to start chatting
          </span>
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
  const chatActionsToolbarIcon = chatActionsOpen
    ? (chatActionsTab === "proof"
      ? Cube
      : chatActionsTab === "handoff"
        ? ArrowBendUpRight
        : TreeStructure)
    : TreeStructure;
  const ChatActionsToolbarIcon = chatActionsToolbarIcon;
  const proofArtifactCount = computerUseSnapshot?.artifacts?.length ?? 0;
  const proofSessionId = selectedSessionId ?? "";
  const agentsTabContent = selectedSubagentPaneAvailable ? (
    <ChatSubagentsPanel
      snapshots={selectedSubagentSnapshots}
      events={selectedEvents}
      onInterruptTurn={turnActive ? () => { void interrupt(); } : undefined}
      variant="pane"
      onSelectSubagent={(selection) => {
        setSubagentView({
          taskId: selection.taskId,
          agentId: selection.agentId,
          agentType: selection.agentType,
          status: selection.status,
          background: selection.background,
        });
      }}
      selectedTaskId={subagentView?.taskId ?? null}
      goal={selectedSession?.provider === "codex" ? selectedCodexGoal : null}
      goalPending={selectedCodexGoalPending}
      onEditGoal={
        selectedSession?.provider === "codex" && selectedSessionId
          ? (next) => {
              void setCodexGoalFromPanel(selectedSessionId, next);
            }
          : undefined
      }
      onClearGoal={
        selectedSession?.provider === "codex" && selectedSessionId
          ? () => {
              void clearCodexGoalFromPanel(selectedSessionId);
            }
          : undefined
      }
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4 py-8 text-center">
      <p className="font-sans text-[13px] text-fg/50">No subagents detected</p>
    </div>
  );
  const proofTabContent = (
    <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
      <ChatComputerUsePanel
        sessionId={proofSessionId}
        snapshot={computerUseSnapshot}
        onRefresh={() => refreshComputerUseSnapshot(selectedSessionId, { force: true })}
      />
    </div>
  );
  const handoffTabContent = canShowHandoff ? (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="space-y-1">
        <div className="font-sans text-[12px] font-semibold text-fg/82">Start a sibling chat on another model</div>
        <div className="text-[11px] leading-5 text-fg/54">
          {handoffTargetProvider === "claude"
            ? "ADE can fork Claude with full SDK history, or start a brief handoff that sends a compact summary."
            : "ADE will create a new work chat, inject a handoff summary from this session, and route you into the new tab."}
        </div>
        {laneId ? (
          <div className="text-[10px] leading-4 text-fg/40">
            New session stays in this lane ({laneDisplayLabel}).
          </div>
        ) : null}
      </div>
      <div className="mt-3 inline-flex items-center gap-1.5">
        <ModelPicker
          value={handoffModelId}
          onChange={setHandoffModelId}
          surfaceKey="chat-handoff"
          {...(handoffAvailableModelIds ? { availableModelIds: handoffAvailableModelIds } : {})}
          onOpenSignIn={openAiProvidersSettings}
        />
        <ReasoningEffortPicker
          modelId={handoffModelId}
          reasoningEffort={handoffReasoningEffort}
          onChange={setHandoffReasoningEffort}
        />
      </div>
      {handoffTargetProvider ? (
        <div className="mt-2 space-y-1.5">
          <div className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-fg/45">Permission mode</div>
          {handoffTargetProvider === "claude" ? (
            <select
              value={handoffClaudePermissionMode}
              onChange={(e) => setHandoffClaudePermissionMode(e.target.value as AgentChatClaudePermissionMode)}
              className={handoffSelectCls}
              aria-label="Claude permission mode for handoff"
            >
              {HANDOFF_CLAUDE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : null}
          {handoffTargetProvider === "codex" ? (
            <div className="space-y-0.5">
              <select
                value={handoffCodexSelectValue}
                title={handoffCodexPermissionPreset === "custom" ? "Non-standard policy; choosing a preset replaces it." : undefined}
                onChange={(e) => {
                  const next = e.target.value as "default" | "plan" | "full-auto" | "config-toml";
                  const updated = handoffApplyCodexPreset(next, {
                    cap: handoffCodexApprovalPolicy,
                    sandbox: handoffCodexSandbox,
                  });
                  setHandoffCodexApprovalPolicy(updated.codexApprovalPolicy);
                  setHandoffCodexSandbox(updated.codexSandbox);
                  setHandoffCodexConfigSource(updated.codexConfigSource);
                }}
                className={handoffSelectCls}
                aria-label="Codex permission preset for handoff"
              >
                <option value="default">Default — write + prompts on risk</option>
                <option value="plan">Plan — read only + prompts</option>
                <option value="full-auto">Full auto — no prompts</option>
                <option value="config-toml">Use codex config.toml</option>
              </select>
              {modelSupportsFastMode(handoffTargetDescriptor) ? (
                <button
                  type="button"
                  className={cn(
                    "mt-1 inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 font-sans text-[11px] font-semibold transition-colors",
                    handoffCodexFastMode
                      ? "border-amber-300/28 bg-amber-400/12 text-amber-100"
                      : "border-white/[0.08] bg-white/[0.03] text-muted-fg/62 hover:bg-white/[0.06] hover:text-fg/78",
                  )}
                  aria-pressed={handoffCodexFastMode}
                  aria-label="Fast mode for handoff"
                  onClick={() => setHandoffCodexFastMode((current) => !current)}
                >
                  <Lightning size={12} weight="fill" />
                  Fast
                </button>
              ) : null}
              {handoffCodexPermissionPreset === "custom" ? (
                <div className="text-[10px] text-amber-200/55">Session uses a custom policy; select a standard preset to apply to the new chat.</div>
              ) : null}
            </div>
          ) : null}
          {handoffTargetProvider === "opencode" ? (
            <select
              value={handoffOpenCodePermissionMode}
              onChange={(e) => setHandoffOpenCodePermissionMode(e.target.value as AgentChatOpenCodePermissionMode)}
              className={handoffSelectCls}
              aria-label="OpenCode permission mode for handoff"
            >
              {HANDOFF_OPENCODE_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : null}
          {handoffTargetProvider === "droid" ? (
            <select
              value={handoffDroidPermissionMode}
              onChange={(e) => setHandoffDroidPermissionMode(e.target.value as AgentChatDroidPermissionMode)}
              className={handoffSelectCls}
              aria-label="Droid autonomy mode for handoff"
            >
              {HANDOFF_DROID_MODES.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
          ) : null}
          {handoffTargetProvider === "cursor" ? (
            <select
              value={handoffCursorModeId?.trim() || "agent"}
              onChange={(e) => {
                setHandoffCursorModeId(e.target.value || "agent");
              }}
              className={handoffSelectCls}
              aria-label="Cursor agent mode for handoff"
            >
              {CURSOR_AVAILABLE_MODE_IDS.map((modeId) => (
                <option key={modeId} value={modeId}>
                  {modeId}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
      <div className="mt-3 rounded-md border border-white/[0.05] bg-white/[0.025] px-2.5 py-2 text-[10px] leading-4 text-fg/44">
        {handoffTargetProvider === "claude"
          ? "Fork keeps the complete Claude transcript through the SDK. Brief sends a summary as the first message."
          : "Create opens the new work chat and sends the handoff summary as its first message."}
      </div>
      <div className="mt-3 flex items-center justify-end gap-2">
        {handoffTargetProvider === "claude" ? (
          <>
            <button
              type="button"
              className="rounded-md border border-white/[0.08] bg-white/[0.035] px-2.5 py-1 font-sans text-[11px] font-medium text-fg/72 transition-colors hover:border-white/[0.14] hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                void handoffSession("brief");
              }}
              disabled={!handoffModelId || handoffBusy || handoffBlocked}
            >
              {handoffBusy ? "Starting..." : "Brief handoff"}
            </button>
            <button
              type="button"
              className="rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] px-2.5 py-1 font-sans text-[11px] font-medium text-fg/86 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
              onClick={() => {
                void handoffSession("fork");
              }}
              disabled={!handoffModelId || handoffBusy || handoffBlocked}
            >
              {handoffBusy ? "Starting..." : "Fork full history"}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] px-2.5 py-1 font-sans text-[11px] font-medium text-fg/86 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
            onClick={() => {
              void handoffSession();
            }}
            disabled={!handoffModelId || handoffBusy || handoffBlocked}
          >
            {handoffBusy ? "Starting..." : "Create handoff chat"}
          </button>
        )}
      </div>
      {handoffBlocked ? (
        <div className="mt-3 text-[10px] leading-4 text-fg/40">{handoffButtonTitle}</div>
      ) : null}
    </div>
  ) : (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4 py-8 text-center">
      <p className="font-sans text-[13px] text-fg/50">Handoff is not available for this chat.</p>
    </div>
  );
  const chatActionsPanelContent = (
    <ChatActionsDrawerPanel
      tab={chatActionsTab}
      onTabChange={setChatActionsTab}
      onClose={() => setChatActionsOpen(false)}
      agentsContent={agentsTabContent}
      proofContent={proofTabContent}
      handoffContent={handoffTabContent}
    />
  );
  const cursorCloudPanelContent = (
    <ChatCursorCloudPanel
      ref={cursorCloudPanelRef}
      cursorCloudAgentId={selectedSession?.cursorCloudAgentId ?? null}
      cursorRuntime={cursorRuntime}
      cursorModelIds={cursorCloudModelIds}
      defaultRepoUrl={null}
      defaultBranch={laneGitBranch}
      defaultModelSdkId={modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : null}
      laneGitRemote={laneGitRemote}
      laneId={laneId ?? null}
      onClose={() => setCursorCloudPaneOpen(false)}
      onOpened={({ sessionId, session }) => {
        setCursorCloudPaneOpen(false);
        if (!sessionId) return;
        loadedHistoryRef.current.delete(sessionId);
        optimisticSessionIdsRef.current.add(sessionId);
        knownSessionIdsRef.current.add(sessionId);
        pendingSelectedSessionIdRef.current = sessionId;
        draftSelectionLockedRef.current = false;
        touchSession(sessionId);
        // In locked-pane mode (single chat tile) `refreshSessions` rewrites
        // selection back to the lock id, so we hand the new session up to the
        // parent — same path createSession uses for new chats.
        if (session) notifySessionCreated(session);
        setSelectedSessionId(sessionId);
        void refreshSessions().catch(() => undefined);
      }}
      onMissingFields={(message) => setError(message)}
    />
  );
  const iosSimulatorPanelContent = (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="font-sans text-[12px] font-medium text-fg/80">iOS Simulator</span>
        <button
          type="button"
          className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/50 transition-colors hover:text-fg/80"
          onClick={() => setIosSimulatorOpen(false)}
          title="Close iOS simulator panel"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <ChatIosSimulatorPanel
          sessionId={selectedSessionId}
          laneId={selectedSession?.laneId ?? laneId}
          projectRoot={iosSimulatorProjectRoot}
          onAddAttachment={addAttachment}
          onInsertDraft={insertComposerDraft}
          onAddContext={addIosElementContext}
          drawerModeRequest={iosSimulatorDrawerModeRequest}
        />
      </div>
    </>
  );
  const appControlPanelContent = (
    <>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-white/[0.06] px-4 py-2.5">
        <span className="font-sans text-[12px] font-medium text-fg/80">App Control</span>
        <button
          type="button"
          className="rounded-md border border-white/[0.06] bg-white/[0.03] px-2 py-0.5 font-sans text-[10px] font-medium text-fg/50 transition-colors hover:text-fg/80"
          onClick={() => setAppControlOpen(false)}
          title="Close App Control panel"
        >
          Close
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-4 py-3">
        <ChatAppControlPanel
          sessionId={selectedSessionId}
          laneId={laneId}
          projectRoot={iosSimulatorProjectRoot}
          onAddAttachment={addAttachment}
          onInsertDraft={insertComposerDraft}
          onShowTerminal={(terminal) => {
            setTerminalDrawerOpen(true);
            setTerminalRevealRequest({ ...terminal, nonce: ++terminalRevealNonceRef.current });
          }}
          onAddContext={addAppControlContext}
        />
      </div>
    </>
  );
  const chatHeaderTrailingActions = (
    <>
          {laneToolsVisible && iosSimulatorAvailable ? (
            <SmartTooltip
              content={{
                label: iosSimulatorOpen ? "Close iOS simulator" : "Open iOS simulator",
                description: "Boot and inspect the iOS simulator alongside this chat.",
                effect: iosElementContextItems.length
                  ? `${iosElementContextItems.length} element context attached`
                  : undefined,
              }}
            >
              <button
                type="button"
                className={cn(
                  chatToolbarActionBase,
                  iosSimulatorOpen
                    ? "border-cyan-300/22 bg-cyan-500/10 text-cyan-100/80"
                    : chatToolbarActionIdle,
                )}
                onClick={() => {
                  setIosSimulatorOpen((current) => {
                    const next = !current;
                    if (next) {
                      setChatActionsOpen(false);
                      setAppControlOpen(false);
                      setCursorCloudPaneOpen(false);
                    }
                    return next;
                  });
                }}
                aria-label={iosSimulatorOpen ? "Close iOS simulator drawer" : "Open iOS simulator drawer"}
                aria-pressed={iosSimulatorOpen}
              >
                <span>Simulator</span>
                <DeviceMobile size={13} weight={iosSimulatorOpen ? "fill" : "regular"} />
                {iosElementContextItems.length ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-cyan-500/80 px-0.5 font-mono text-[8px] font-bold text-black">
                    {iosElementContextItems.length}
                  </span>
                ) : null}
              </button>
            </SmartTooltip>
          ) : null}
          {laneToolsVisible && appControlAvailable ? (
            <SmartTooltip
              content={{
                label: appControlOpen ? "Close App Control" : "Open App Control",
                description: "Launch or attach to an Electron app to inspect, click, and capture context.",
                effect: appControlContextItems.length
                  ? `${appControlContextItems.length} element context attached`
                  : undefined,
              }}
            >
              <button
                type="button"
                className={cn(
                  chatToolbarActionBase,
                  appControlOpen
                    ? "border-sky-300/22 bg-sky-500/10 text-sky-100/80"
                    : chatToolbarActionIdle,
                )}
                onClick={() => {
                  setAppControlOpen((current) => {
                    const next = !current;
                    if (next) {
                      setChatActionsOpen(false);
                      setIosSimulatorOpen(false);
                    }
                    return next;
                  });
                }}
                aria-label={appControlOpen ? "Close App Control drawer" : "Open App Control drawer"}
                aria-pressed={appControlOpen}
              >
                <span>Desktop</span>
                <Desktop size={13} weight={appControlOpen ? "fill" : "regular"} />
                {appControlContextItems.length ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-sky-500/80 px-0.5 font-mono text-[8px] font-bold text-black">
                    {appControlContextItems.length}
                  </span>
                ) : null}
              </button>
            </SmartTooltip>
          ) : null}
          {showWorkspaceChrome && laneId ? (
            <QuickRunMenu
              laneId={laneId}
              compact
              label="Run"
              align="end"
              triggerStyle={{ height: 24, padding: "0 8px" }}
            />
          ) : null}
          {(showWorkspaceChrome && laneId) || canShowHandoff ? (
            <SmartTooltip
              content={{
                label: chatActionsOpen ? "Close chat actions" : "Open chat actions",
                description: chatActionsOpen
                  ? "Hide agents, proof artifacts, and handoff controls."
                  : "Open agents, proof artifacts, and handoff controls for this chat.",
                effect: [
                  proofArtifactCount > 0 ? `${proofArtifactCount} artifact${proofArtifactCount === 1 ? "" : "s"}` : null,
                  selectedSubagentSnapshots.length > 0
                    ? `${selectedSubagentSnapshots.length} subagent${selectedSubagentSnapshots.length === 1 ? "" : "s"}`
                    : null,
                ].filter(Boolean).join(" · ") || undefined,
              }}
            >
              <button
                type="button"
                className={cn(
                  chatToolbarActionBase,
                  chatActionsOpen
                    ? "border-violet-400/22 bg-violet-500/10 text-violet-100/80"
                    : chatToolbarActionIdle,
                )}
                onClick={() => {
                  setError(null);
                  setChatActionsOpen((current) => {
                    const next = !current;
                    if (next) {
                      setIosSimulatorOpen(false);
                      setCursorCloudPaneOpen(false);
                      setAppControlOpen(false);
                    }
                    return next;
                  });
                }}
                title={chatActionsOpen ? "Close chat actions drawer" : "Open chat actions drawer"}
                aria-label={chatActionsOpen ? "Close chat actions drawer" : "Open chat actions drawer"}
                aria-pressed={chatActionsOpen}
              >
                <span>Chat actions</span>
                <ChatActionsToolbarIcon size={13} weight={chatActionsOpen ? "fill" : "regular"} />
                {proofArtifactCount > 0 ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-emerald-500/80 px-0.5 font-mono text-[8px] font-bold text-black">
                    {proofArtifactCount}
                  </span>
                ) : selectedSubagentSnapshots.length > 0 ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-amber-400/85 px-0.5 font-mono text-[8px] font-bold text-black">
                    {selectedSubagentSnapshots.length}
                  </span>
                ) : null}
                {!chatActionsOpen && hasRunningBackgroundSubagent ? (
                  <span
                    aria-hidden
                    className={cn(
                      "absolute -bottom-0.5 -right-0.5 h-[7px] w-[7px] rounded-full",
                      "bg-[color:var(--color-accent,#A78BFA)] ring-2 ring-[color:var(--color-bg,#0c0b10)]",
                      "motion-safe:ade-glow-pulse",
                    )}
                  />
                ) : null}
              </button>
            </SmartTooltip>
          ) : null}
          {chatTerminalVisible ? <ChatTerminalToggle open={terminalDrawerOpen} onToggle={() => setTerminalDrawerOpen((v) => !v)} /> : null}
          {selectedSession?.provider === "codex"
            && selectedSessionId
            && selectedSession.threadId ? (
            <CodexOpenInCliButton
              sessionId={selectedSessionId}
              onUseAdeTerminal={(args) => {
                // Open the ADE terminal drawer and write the resume command
                // into the chat's active terminal pane (plan §D.1). Falls
                // back to copying the command if the chat doesn't yet have an
                // active terminal session.
                setTerminalDrawerOpen(true);
                const quoted = (parts: string[]) =>
                  parts.map((p) => `'${p.replace(/'/g, "'\\''")}'`).join(" ");
                const fullCommand = `cd ${quoted([args.cwd])} && ${quoted([args.binary, ...args.argv])}\r`;
                void (async () => {
                  try {
                    const active = await window.ade.terminal.activeForChat({
                      chatSessionId: selectedSessionId,
                    });
                    if (active?.ptyId) {
                      await window.ade.terminal.write({
                        ptyId: active.ptyId,
                        chatSessionId: selectedSessionId,
                        data: fullCommand,
                      });
                      return;
                    }
                  } catch {
                    // fall through to clipboard
                  }
                  await navigator.clipboard.writeText(fullCommand.trimEnd()).catch(() => undefined);
                })();
              }}
            />
          ) : null}
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
          {!lockedSingleSessionMode && selectedSessionId ? (
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
    </>
  );
  const shellHeader = (
    <div className={CHAT_SHELL_HEADER_CLASS}>
      <WorkSurfaceHeader
        title={resolvedTitle}
        laneId={laneId}
        laneChipName={chatHeaderLaneName}
        laneChipColor={chatHeaderLaneColor}
        showLaneChip={showWorkspaceChrome}
        onLaneChipClick={laneId ? () => navigate(openLaneInLanesTabPath(laneId)) : undefined}
        showCacheBadge={showClaudeCacheTimer}
        cacheIdleSinceAt={selectedSession?.idleSinceAt ?? null}
        showGitToolbar={showWorkspaceChrome}
        trailingActions={chatHeaderTrailingActions}
        className="space-y-0 p-0"
      />

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
                  onContextMenu={(event) => {
                    event.preventDefault();
                    void requestArchiveChat(session.sessionId, title);
                  }}
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
              draftLaunchConfigHydratedRef.current = null;
              draftLaunchConfigTouchedKeyRef.current = null;
              setError(null);
              setSelectedSessionId(null);
              setDraft("");
              setAttachments([]);
              setContextAttachments([]);
            }}
          >
            <Plus size={10} weight="bold" />
          </button>
          {archivedSessions.length ? (
            <select
              className="h-7 max-w-[160px] shrink-0 rounded-md border border-white/[0.06] bg-black/20 px-2 font-sans text-[11px] text-muted-fg/60 outline-none transition-colors hover:border-white/[0.1] hover:text-fg"
              title="Restore archived chat"
              defaultValue=""
              onChange={(event) => {
                const sessionId = event.currentTarget.value;
                event.currentTarget.value = "";
                if (sessionId) handleUnarchiveChat(sessionId);
              }}
            >
              <option value="">Archived ({archivedSessions.length})</option>
              {archivedSessions.map((session) => (
                <option key={session.sessionId} value={session.sessionId}>
                  Restore {chatSessionTitle(session)}
                </option>
              ))}
            </select>
          ) : null}
        </div>
      ) : null}
    </div>
  );

  const activeOrchestrationRole = selectedSession?.orchestrationRole ?? null;
  const isOrchestratorLead = selectedSession?.interactionMode === "orchestrator-lead";
  const isOrchestratorDraft = forceDraft && workDraftKind === "chat-orchestrator" && selectedSessionId == null;

  const composerElement = (
      <AgentChatComposer
            surfaceMode={surfaceMode}
            layoutVariant={layoutVariant}
            composerMaxHeightPx={composerMaxHeightPx}
            isActive={isTileActive}
            shouldAutofocus={layoutVariant === "grid-tile" ? shouldAutofocusComposer : false}
            sdkSlashCommands={sdkSlashCommands}
            modelId={modelId}
            availableModelIds={effectiveAvailableModelIds}
            constrainModelSelection={modelSelectionConstrained}
            modelUnavailableMessage={constrainedModelSelectionError ?? undefined}
            providerAuthStatus={modelPickerProviderAuthStatus}
            onRuntimeCatalogRefreshed={() => {
              setRuntimeCatalogVersion((version) => version + 1);
            }}
            allowCliOnlyModels={workDraftKind === "cli"}
            reasoningEffort={reasoningEffort}
            codexFastMode={codexFastMode}
            codexTokenUsage={selectedCodexTokenUsage}
            draft={draft}
            attachments={attachments}
            contextAttachments={contextAttachments}
            allowAttachmentOnlySubmit={workDraftKind === "cli"}
            pinnedLinearIssue={pinnedLinearIssue}
            pendingInput={composerPendingInput}
            approvalResponding={pendingInput ? respondingApprovalIds.has(pendingInput.itemId) : false}
            turnActive={turnActive}
            sendOnEnter={sendOnEnter}
            busy={busy || projectTransitionBlocksChat}
            sessionProvider={sessionProvider}
            interactionMode={interactionMode}
            claudePermissionMode={claudePermissionMode}
            codexApprovalPolicy={codexApprovalPolicy}
            codexSandbox={codexSandbox}
            codexConfigSource={codexConfigSource}
            opencodePermissionMode={opencodePermissionMode}
            droidPermissionMode={droidPermissionMode}
            cursorModeSnapshot={effectiveCursorModeSnapshot}
            executionMode={selectedExecutionMode?.value ?? "focused"}
            computerUseSnapshot={computerUseSnapshot}
            iosElementContextItems={iosElementContextItems}
            appControlContextItems={appControlContextItems}
            builtInBrowserContextItems={builtInBrowserContextItems}
            macosVmContextItems={macosVmContextItems}
            executionModeOptions={launchModeEditable ? executionModeOptions : []}
            modelSelectionLocked={modelSelectionLocked || sessionMutationKind === "model" || turnActive || projectTransitionBlocksChat}
            permissionModeLocked={permissionModeLocked || identitySessionSettingsBusy || projectTransitionBlocksChat}
            hideNativeControls={hideNativeControls}
            messagePlaceholder={effectiveMessagePlaceholder}
            onExecutionModeChange={handleExecutionModeChange}
            onInteractionModeChange={(value) => { void updateNativeControls({ interactionMode: value }); }}
            onClaudeModeChange={handleClaudeModeChange}
            onClaudePermissionModeChange={(value) => { void updateNativeControls({ claudePermissionMode: value }); }}
            onCodexPresetChange={(next) => { void updateNativeControls(next); }}
            onCodexApprovalPolicyChange={(value) => { void updateNativeControls({ codexApprovalPolicy: value }); }}
            onCodexSandboxChange={(value) => { void updateNativeControls({ codexSandbox: value }); }}
            onCodexConfigSourceChange={(value) => { void updateNativeControls({ codexConfigSource: value }); }}
            onOpenCodePermissionModeChange={(value) => { void updateNativeControls({ opencodePermissionMode: value }); }}
            onDroidPermissionModeChange={(value) => { void updateNativeControls({ droidPermissionMode: value }); }}
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
            onRemoveIosElementContext={removeIosElementContext}
            onRemoveAppControlContext={removeAppControlContext}
            onRemoveBuiltInBrowserContext={removeBuiltInBrowserContext}
            onRemoveMacosVmContext={removeMacosVmContext}
            onOpenAiSettings={openAiProvidersSettings}
            onOpenLinearSettings={openLinearSettings}
            launchPromptClipboardEnabled={launchPromptClipboardEnabled}
            launchPromptClipboardNoticeEnabled={launchPromptClipboardNoticeEnabled}
            onOpenLaunchPromptClipboardSettings={openLaunchPromptClipboardSettings}
            onStartOrchestratorChat={() => {
              // Switch the lane to a fresh orchestrator-lead draft. The
              // submit path will then call `agentChat.create` +
              // `orchestration.runCreate` together.
              try {
                window.dispatchEvent(
                  new CustomEvent("ade:work:start-orchestrator-chat"),
                );
              } catch {
                /* dispatch is best-effort */
              }
            }}
            onStopOrchestratorChat={() => {
              try {
                window.dispatchEvent(
                  new CustomEvent("ade:work:stop-orchestrator-chat"),
                );
              } catch {
                /* dispatch is best-effort */
              }
            }}
            orchestratorModeActive={isOrchestratorDraft || isOrchestratorLead}
            orchestrationRole={isOrchestratorDraft ? "lead" : activeOrchestrationRole}
            onModelChange={(nextModelId) => {
              const modelAllowed =
                modelSelectionConstrained
                  ? effectiveAvailableModelIds.includes(nextModelId)
                  : (
                      !effectiveAvailableModelIds.length
                      || effectiveAvailableModelIds.includes(nextModelId)
                      || isKnownSelectableChatModelId(nextModelId)
                      || Boolean(resolveModelDescriptorWithRuntimeCatalog(nextModelId))
                    );
              if (!modelAllowed) {
                return;
              }
              if (isPersistentIdentitySurface && sessionMutationKind) {
                return;
              }
              if (!selectedSessionId) {
                draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
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
                ...(modelSupportsFastMode(snapshot.nextDesc) ? { codexFastMode } : {}),
                ...nextNativeControlPayload,
              }).then((updatedSession) => {
                applyModelSelectionSnapshot(snapshot);
                patchSessionSummary(selectedSessionId, {
                  provider: updatedSession.provider,
                  model: updatedSession.model,
                  modelId: updatedSession.modelId,
                  reasoningEffort: updatedSession.reasoningEffort ?? null,
                  codexFastMode: updatedSession.codexFastMode === true,
                  permissionMode: updatedSession.permissionMode,
                  interactionMode: updatedSession.interactionMode ?? null,
                  claudePermissionMode: updatedSession.claudePermissionMode,
                  codexApprovalPolicy: updatedSession.codexApprovalPolicy,
                  codexSandbox: updatedSession.codexSandbox,
                  codexConfigSource: updatedSession.codexConfigSource,
                  opencodePermissionMode: updatedSession.opencodePermissionMode,
                  droidPermissionMode: updatedSession.droidPermissionMode,
                  cursorModeId: updatedSession.cursorModeId,
                  cursorModeSnapshot: updatedSession.cursorModeSnapshot,
                });
                getAgentChatSlashCommandsCached({ sessionId: selectedSessionId }, { force: true })
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
            onReasoningEffortChange={handleReasoningEffortChange}
            onCodexFastModeChange={handleCodexFastModeChange}
            onDraftChange={updateComposerDraft}
            onClearDraft={() => updateComposerDraft("")}
            onSubmit={() => {
              void submit();
            }}
            onSubmitBlocked={(message) => setError(message)}
            onSubmitInBackground={showDraftLaunchControls ? () => {
              if (workDraftKind === "cli") {
                void launchDraftCliSession("background");
                return;
              }
              void launchDraftChat("background");
            } : undefined}
            backgroundLaunchBusy={false}
            backgroundLaunchLabel={draftLaunchTargetIsAutoCreate ? "Auto-create" : "Background"}
            onInterrupt={() => {
              void interrupt();
            }}
            onApproval={(decision, responseText, answers) => {
              void approve(decision, responseText, answers);
            }}
            onAddAttachment={addAttachment}
            onRemoveAttachment={removeAttachment}
            onAddContextAttachment={addContextAttachment}
            onRemoveContextAttachment={removeContextAttachment}
            onSearchAttachments={searchAttachments}
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
            onDispatchSteerInline={selectedSession?.provider === "claude" ? (steerId) => {
              if (selectedSessionId) {
                void window.ade.agentChat.dispatchSteer({ sessionId: selectedSessionId, steerId, mode: "inline" });
              }
            } : undefined}
            onDispatchSteerInterrupt={selectedSession?.provider === "claude" ? (steerId) => {
              if (selectedSessionId) {
                void window.ade.agentChat.dispatchSteer({ sessionId: selectedSessionId, steerId, mode: "interrupt" });
              }
            } : undefined}
            sessionId={selectedSessionId}
            showParallelChatToggle={Boolean(
              embeddedWorkLayout && forceDraft && workDraftKind === "chat" && !lockSessionId && !initialSessionId && selectedSessionId == null,
            )}
            showIosSimulatorToggle={laneToolsVisible && iosSimulatorAvailable}
            iosSimulatorOpen={iosSimulatorOpen}
            onToggleIosSimulator={() => {
              setIosSimulatorOpen((current) => {
                const next = !current;
                if (next) {
                  setChatActionsOpen(false);
                  setAppControlOpen(false);
                  setCursorCloudPaneOpen(false);
                }
                return next;
              });
            }}
            showAppControlToggle={laneToolsVisible && appControlAvailable}
            appControlOpen={appControlOpen}
            onToggleAppControl={() => {
              setAppControlOpen((current) => {
                const next = !current;
                if (next) {
                  setChatActionsOpen(false);
                  setIosSimulatorOpen(false);
                  setCursorCloudPaneOpen(false);
                }
                return next;
              });
            }}
            cursorCloudAvailable={cursorCloudAvailable}
            cursorCloudCanLaunch={cursorCloudCanLaunch}
            cursorCloudAgentId={selectedSession?.cursorCloudAgentId ?? null}
            cursorCloudPaneOpen={cursorCloudPaneOpen}
            cursorCloudActiveCount={cursorCloudActiveCount}
            cursorCloudLaunchModeOpen={cursorCloudLaunchModeOpen}
            cursorCloudLaunchPanel={
              cursorCloudLaunchModeOpen ? (
                <CursorCloudInlineLaunch
                  ref={cursorCloudInlineLaunchRef}
                  cursorModelIds={cursorCloudModelIds}
                  defaultBranch={laneGitBranch}
                  defaultModelSdkId={modelId.startsWith("cursor/") ? modelId.slice("cursor/".length) : null}
                  laneGitRemote={laneGitRemote}
                  laneId={laneId ?? null}
                  onClose={() => setCursorCloudLaunchModeOpen(false)}
                  onLaunched={() => {
                    setCursorCloudLaunchModeOpen(false);
                    void refreshSessions().catch(() => undefined);
                  }}
                  onMissingFields={(message) => setError(message)}
                />
              ) : null
            }
            onOpenCloudLaunchMode={() => {
              setCursorCloudLaunchModeOpen(true);
              setCursorCloudPaneOpen(false);
              setChatActionsOpen(false);
            }}
            onCloseCloudLaunchMode={() => setCursorCloudLaunchModeOpen(false)}
            onOpenCloudBringToLocal={() => {
              setChatActionsOpen(false);
              setCursorCloudPaneOpen(true);
            }}
            onSubmitToCloud={async (promptText) => {
              void copyPromptForLaunch(promptText);
              if (cursorCloudLaunchModeOpen) {
                const result = await cursorCloudInlineLaunchRef.current?.launchWithPrompt(promptText);
                return Boolean(result);
              }
              const result = await cursorCloudPanelRef.current?.launchWithPrompt(promptText);
              return Boolean(result);
            }}
            parallelChatMode={parallelChatMode}
            onParallelChatModeChange={(enabled) => {
              if (enabled && attachments.length > PARALLEL_CHAT_MAX_ATTACHMENTS) {
                setError(`Parallel mode supports up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} attachments. ${attachments.length - PARALLEL_CHAT_MAX_ATTACHMENTS} attachment(s) were removed.`);
                setAttachments((prev) => prev.slice(0, PARALLEL_CHAT_MAX_ATTACHMENTS));
              }
              setParallelChatMode(enabled);
              if (!enabled) {
                setParallelModelSlots([]);
                setParallelConfiguringIndex(null);
              }
            }}
            parallelModelSlots={parallelModelSlots}
            parallelConfiguringIndex={parallelConfiguringIndex}
            onParallelConfiguringIndexChange={setParallelConfiguringIndex}
            onParallelAddModel={() => {
              setParallelModelSlots((prev) => [
                ...prev,
                cloneParallelSlotFromComposer({
                  native: nativeControlsRef.current,
                  modelId,
                  reasoningEffort,
                  codexFastMode,
                  executionMode,
                }),
              ]);
            }}
            onParallelRemoveModel={(index) => {
              setParallelModelSlots((prev) => prev.filter((_, i) => i !== index));
              setParallelConfiguringIndex((cur) => {
                if (cur == null) return cur;
                if (cur === index) return null;
                if (cur > index) return cur - 1;
                return cur;
              });
            }}
            onParallelSlotModelChange={(index, nextModelId) => {
              if (modelSelectionConstrained && !effectiveAvailableModelIds.includes(nextModelId)) return;
              const desc = resolveModelDescriptorWithRuntimeCatalog(nextModelId) ?? getModelById(nextModelId);
              const tiers = desc?.reasoningTiers ?? [];
              const preferred = readLastUsedReasoningEffort({ laneId, modelId: nextModelId });
              const nextEffort = selectReasoningEffort({ tiers, preferred });
              const previousPermissionDesc = getModelDescriptorForPermissionMode(parallelModelSlots[index]?.modelId ?? "");
              const nextPermissionDesc = getModelDescriptorForPermissionMode(nextModelId);
              const nextRecommendedOpenCodeMode = recommendedOpenCodePermissionModeForModel(nextPermissionDesc);
              const resetOpenCodePermissionToDefault = shouldResetOpenCodePermissionForModelSwitch(
                previousPermissionDesc,
                nextPermissionDesc,
              );
              const nextExecOpts = getExecutionModeOptions(desc);
              patchParallelSlot(index, {
                modelId: nextModelId,
                reasoningEffort: nextEffort,
                executionMode: nextExecOpts.some((o) => o.value === parallelModelSlots[index]?.executionMode)
                  ? parallelModelSlots[index]!.executionMode
                  : (nextExecOpts[0]?.value ?? "focused"),
                ...(resetOpenCodePermissionToDefault
                  ? {
                    opencodePermissionMode: nextRecommendedOpenCodeMode ?? initialNativeControls.opencodePermissionMode,
                  }
                  : {}),
              });
            }}
            onParallelSlotReasoningChange={(index, effort) => {
              patchParallelSlot(index, { reasoningEffort: effort });
            }}
            onParallelSlotCodexFastModeChange={(index, enabled) => {
              patchParallelSlot(index, { codexFastMode: enabled });
            }}
            parallelLaunchBusy={parallelLaunchBusy}
            parallelLaunchStatus={parallelLaunchStatus}
            parallelControlSlot={parallelComposerControlSlot}
            parallelSlotExecutionModeOptions={parallelSlotExecutionModeOptions}
            parallelSlotExecutionMode={parallelConfiguringRow?.executionMode ?? null}
            onParallelSlotExecutionModeChange={(mode) => {
              if (parallelConfiguringIndex == null) return;
              patchParallelSlot(parallelConfiguringIndex, { executionMode: mode });
            }}
      />
  );

  // Composer placeholder shown when the chat is drilled in to a subagent
  // transcript. Replies always go to the parent session, so disabling input
  // here matches user expectations and the wireframe brief.
  const subagentComposerLock = subagentView ? (
    <div
      data-chat-appearance-root
      style={chatAppearanceRootStyle}
      className={cn(
        compactShell ? "min-w-0 w-full" : undefined,
        "flex items-center gap-3 px-4 py-3 font-sans text-[12px]",
        "border-t border-white/[0.05] bg-white/[0.012]",
      )}
    >
      <span
        aria-hidden
        className="inline-flex h-5 w-5 items-center justify-center rounded-full text-fg/30"
      >
        <span className="block h-px w-2.5 bg-fg/30" />
      </span>
      <span className="min-w-0 flex-1 text-fg/55">
        Composer paused — viewing a subagent transcript.
      </span>
      <button
        type="button"
        onClick={() => setSubagentView(null)}
        className={cn(
          "shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium",
          "text-[color:var(--color-accent-bright,#C4B5FD)]",
          "transition-colors hover:bg-[color:var(--color-accent,#A78BFA)]/10",
        )}
      >
        Return to main chat
      </button>
    </div>
  ) : null;

  const composerWithTypographyRoot = (
    <div
      data-chat-appearance-root
      style={chatAppearanceRootStyle}
      className={cn(compactShell ? "min-w-0 w-full" : undefined, "space-y-2")}
    >
      {draftLaunchJobs.map((job) => {
        const isFailed = job.status === "failed";
        const isReady = job.status === "ready";
        const isActiveJob = !isDraftLaunchJobTerminal(job.status);
        const isStaleActiveJob = isDraftLaunchJobStale(job, draftLaunchJobNowMs);
        const canOpen = isReady && Boolean(job.laneId && job.laneName && job.sessionId);
        return (
          <div
            key={job.id}
            data-testid="draft-launch-job"
            aria-live={isActiveJob ? "polite" : undefined}
            className={cn(
              "flex items-start justify-between gap-3 rounded-lg border px-3 py-2.5 font-sans text-[11px] shadow-[0_10px_40px_rgba(0,0,0,0.10)]",
              isFailed && "border-rose-300/20 bg-rose-500/[0.08] text-rose-100/90",
              isReady && "border-emerald-300/20 bg-emerald-500/[0.08] text-emerald-100/90",
              isActiveJob && "border-white/10 bg-white/[0.045] text-fg/75",
            )}
          >
            <div className="flex min-w-0 items-start gap-2">
              {isActiveJob ? (
                <CircleNotch size={13} weight="bold" className="mt-0.5 shrink-0 animate-spin text-fg/55" aria-hidden />
              ) : null}
              <div className="min-w-0 space-y-0.5 text-left">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span className={cn(
                    "shrink-0 rounded-full border px-1.5 py-px text-[9px] font-medium tracking-normal",
                    isFailed
                      ? "border-rose-200/20 bg-rose-200/[0.08] text-rose-50/75"
                      : isReady
                        ? "border-emerald-200/20 bg-emerald-200/[0.08] text-emerald-50/75"
                        : "border-white/10 bg-white/[0.06] text-fg/55",
                  )}>
                    {draftLaunchJobLabel(job)}
                  </span>
                  <span className="min-w-0 truncate font-medium">{job.title}</span>
                </div>
                <div className={cn(
                  "min-w-0 text-[10px] leading-4 opacity-75",
                  !isStaleActiveJob && "truncate",
                )}>
                  {isStaleActiveJob ? staleDraftLaunchJobMessage(job) : draftLaunchJobMessage(job)}
                </div>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isFailed ? (
                <button
                  type="button"
                  className="rounded-md border border-rose-200/20 bg-rose-300/[0.10] px-2 py-0.5 text-[10px] font-medium text-rose-50 transition-colors hover:bg-rose-300/[0.16]"
                  onClick={() => {
                    restoreDraftLaunchSnapshot(job.snapshot);
                    dismissDraftLaunchJob(job.id);
                  }}
                >
                  Restore
                </button>
              ) : null}
              {canOpen ? (
                <button
                  type="button"
                  className="rounded-md border border-emerald-200/20 bg-emerald-300/[0.10] px-2 py-0.5 text-[10px] font-medium text-emerald-50 transition-colors hover:bg-emerald-300/[0.16]"
                  onClick={() => openLaunchedDraftSession({
                    laneId: job.laneId!,
                    laneName: job.laneName!,
                    sessionId: job.sessionId!,
                    draftKind: job.draftKind,
                    jobId: job.id,
                  })}
                >
                  Open
                </button>
              ) : null}
              {(!isActiveJob || isStaleActiveJob) ? (
                <button
                  type="button"
                  aria-label={isFailed ? "Dismiss failed launch" : isStaleActiveJob ? "Hide stale launch status" : "Dismiss launch status"}
                  className={cn(
                    "grid h-5 w-5 place-items-center rounded-md transition-colors",
                    isFailed
                      ? "text-rose-50/70 hover:bg-rose-300/[0.12] hover:text-rose-50"
                      : isStaleActiveJob
                        ? "text-fg/45 hover:bg-white/10 hover:text-fg/75"
                        : "text-fg/55 hover:bg-white/10 hover:text-fg/80",
                  )}
                  onClick={() => dismissDraftLaunchJob(job.id)}
                >
                  <X size={12} weight="bold" aria-hidden />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {composerElement}
    </div>
  );

  // True when a non-proof companion panel is open. These panels (iOS simulator,
  // App Control) host their own input affordances, so the empty-state layout
  // shrinks the hero and moves the composer below.
  const appPanelOpen = effectiveIosSimulatorOpen || effectiveAppControlOpen;
  const effectiveCursorCloudPaneOpen = cursorCloudPaneOpen && cursorCloudAvailable;
  // Orchestration: derive runId / role from the active session. When set, mount
  // the right plan panel and (for "orchestrator-lead") wrap the chat surface in
  // the conic-gradient frame.
  const orchestrationRunId = selectedSession?.orchestrationRunId ?? null;
  const orchestrationRole = activeOrchestrationRole;
  const orchestrationPanelOpen = Boolean(orchestrationRunId);
  const rightPaneOpen = chatActionsOpen || appPanelOpen || effectiveCursorCloudPaneOpen || orchestrationPanelOpen;
  const supportsSplit = layoutVariant !== "grid-tile";
  const splitChatColStyle: React.CSSProperties | undefined =
    rightPaneOpen && supportsSplit ? { flexGrow: 100 - rightPaneSplit } : undefined;
  const splitRightPaneStyle: React.CSSProperties | undefined =
    rightPaneOpen && supportsSplit ? { flexGrow: rightPaneSplit, flexBasis: 0 } : undefined;
  const rightPaneDivider = rightPaneOpen && supportsSplit ? (
    <div
      role="separator"
      aria-orientation="vertical"
      onMouseDown={handleRightPaneDividerDown}
      className="relative w-[5px] shrink-0 cursor-col-resize bg-white/[0.06] transition-colors hover:bg-[var(--color-accent)]/25 active:bg-[var(--color-accent)]/40"
    />
  ) : null;
  // Wrap a right-side panel for either grid-tile (overlay) or standard
  // (resizable split) layout. Used for proof, iOS simulator, and App Control
  // panels which all share the same outer chrome.
  const renderRightPane = (content: React.ReactNode) =>
    layoutVariant === "grid-tile" ? (
      <div className="absolute inset-3 z-10 flex min-h-0 flex-col overflow-hidden rounded-xl border border-white/[0.08] bg-[color:color-mix(in_srgb,var(--chat-panel-bg-strong)_92%,black_8%)] shadow-[var(--chat-shell-shadow)] backdrop-blur-xl">
        {content}
      </div>
    ) : (
      <div
        style={splitRightPaneStyle}
        className="flex h-full min-w-0 flex-1 basis-0 flex-col bg-surface/80"
      >
        {content}
      </div>
    );

  // Orchestration plan panel — mounted whenever the active session has a
  // runId. Lead view is fully interactive; worker/validator view is read-only.
  const orchestrationPanelContent = orchestrationRunId ? (
    <OrchestrationPanel
      runId={orchestrationRunId}
      laneId={selectedSession?.laneId ?? laneId ?? ""}
      laneName={laneLabel ?? null}
      viewerRole={orchestrationRole ?? undefined}
      bundleRoot={selectedSession?.orchestrationBundlePath ?? null}
      planApprovalPending={planApprovalPendingInput ? {
        itemId: planApprovalPendingInput.itemId,
        request: planApprovalPendingInput.request,
        responding: respondingApprovalIds.has(planApprovalPendingInput.itemId),
      } : null}
      onPlanApproval={(itemId, decision, responseText, answers) => {
        void handleApproval(itemId, decision, responseText, answers);
      }}
      onOpenSession={(sessionId) => {
        // Switch the Work tab to the target chat session.
        try {
          window.dispatchEvent(
            new CustomEvent("ade:work:select-session", { detail: { sessionId } }),
          );
        } catch {
          /* no-op */
        }
      }}
    />
  ) : null;

  return (
    <>
      <OrchestratorLeadFrame active={false} className="flex h-full min-h-0 w-full min-w-0 flex-col">
      <ChatSurfaceShell
        containerRef={shellRef}
        mode={surfaceMode}
        accentColor={presentation?.accentColor ?? draftAccent}
        contentScale={1}
        chromeTint={chatChromeTint}
        shellGeometry={chatShellGeometry}
        className={compactShell ? cn("border-0 shadow-none rounded-none bg-transparent") : undefined}
        header={compactShell ? undefined : shellHeader}
        footer={isEmptyState || appPanelOpen
          ? undefined
          : subagentComposerLock ?? composerWithTypographyRoot}
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
                  transition={{ duration: 0.12, ease: "easeOut" }}
                  className="absolute inset-0 flex min-h-0 overflow-hidden"
                >
                  {/* Chat column */}
                  <div
                    data-chat-appearance-root
                    style={{ ...chatAppearanceRootStyle, ...splitChatColStyle }}
                    className={cn(
                      "flex min-h-0 flex-1 basis-0 flex-col overflow-hidden",
                      layoutVariant === "grid-tile" ? "min-w-0" : "min-w-[280px]",
                    )}
                  >
                    {(orchestrationRole === "worker" || orchestrationRole === "validator") && orchestrationRunId ? (
                      <div
                        data-orchestration-role-banner={orchestrationRole}
                        className={cn(
                          "flex shrink-0 items-center gap-2 border-b px-4 py-1.5 font-sans text-[11px]",
                          orchestrationRole === "worker"
                            ? "border-sky-300/20 bg-sky-500/[0.05] text-sky-100/85"
                            : "border-emerald-300/20 bg-emerald-500/[0.05] text-emerald-100/85",
                        )}
                      >
                        <span
                          className={cn(
                            "inline-flex h-4 items-center rounded-sm px-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.16em]",
                            orchestrationRole === "worker"
                              ? "border border-sky-300/30 bg-sky-300/10 text-sky-100"
                              : "border border-emerald-300/30 bg-emerald-300/10 text-emerald-100",
                          )}
                        >
                          {orchestrationRole}
                          {selectedSession?.orchestrationTag ? ` · ${selectedSession.orchestrationTag.toLowerCase()}` : ""}
                        </span>
                        {selectedSession?.orchestrationParentSessionId ? (
                          <button
                            type="button"
                            onClick={() => {
                              const targetId = selectedSession.orchestrationParentSessionId;
                              if (!targetId) return;
                              try {
                                window.dispatchEvent(
                                  new CustomEvent("ade:work:select-session", {
                                    detail: { sessionId: targetId },
                                  }),
                                );
                              } catch {
                                /* no-op */
                              }
                            }}
                            className="inline-flex items-center text-fg/80 underline-offset-2 hover:underline"
                          >
                            Lead chat
                          </button>
                        ) : null}
                        {selectedSession?.orchestrationStepId ? (
                          <span className="text-fg/60">
                            · Task <span className="font-mono text-fg/80">{selectedSession.orchestrationStepId}</span>
                          </span>
                        ) : null}
                      </div>
                    ) : null}
                    {selectedSession?.cursorRuntime === "cloud" && selectedSession?.cursorCloudAgentId ? (
                      <div
                        className="shrink-0 border-b border-violet-300/20 bg-violet-500/[0.06] px-4 py-1.5 font-sans text-[11px] leading-snug text-violet-100/85"
                        role="status"
                      >
                        Live view of Cursor Cloud agent. Replies run in cloud.
                      </div>
                    ) : null}
                    {/* Codex chat goal is rendered in the Agents tab via
                        ChatSubagentsPanel; the in-chat banner was removed so
                        the chat header stays clean and goal context lives next
                        to subagents + progress where it belongs. */}
                    {subagentView ? (
                      <button
                        type="button"
                        onClick={() => setSubagentView(null)}
                        title="Return to main chat"
                        className={cn(
                          "group flex shrink-0 items-center gap-2.5 px-5 py-2 text-left font-sans text-[11.5px]",
                          "border-b border-white/[0.05] bg-white/[0.012]",
                          "transition-colors hover:bg-white/[0.025]",
                        )}
                      >
                        <span
                          aria-hidden
                          className="inline-flex h-4 w-4 items-center justify-center rounded-full text-fg/35 transition-colors group-hover:bg-white/[0.05] group-hover:text-fg/70"
                        >
                          {"←"}
                        </span>
                        <span className="text-fg/45 group-hover:text-fg/65">Main</span>
                        <span aria-hidden className="text-fg/20">{"•"}</span>
                        <span className="truncate font-medium tracking-[0.005em] text-fg/85">
                          {subagentView.agentType
                            ?? subagentViewSnapshot?.description
                            ?? subagentView.agentId
                            ?? subagentView.taskId}
                        </span>
                        {subagentView.background ? (
                          <span className="text-[10.5px] tracking-[0.01em] text-fg/30">bg</span>
                        ) : null}
                        <span aria-hidden className="text-fg/20">{"•"}</span>
                        <span
                          className={cn(
                            "text-[10.5px] tracking-[0.005em]",
                            (subagentViewSnapshot?.status ?? subagentView.status) === "running"
                              && "text-[color:var(--color-accent-bright,#C4B5FD)]",
                            (subagentViewSnapshot?.status ?? subagentView.status) === "completed"
                              && "text-emerald-300/75",
                            (subagentViewSnapshot?.status ?? subagentView.status) === "failed"
                              && "text-rose-300/80",
                            (subagentViewSnapshot?.status ?? subagentView.status) === "stopped"
                              && "text-amber-200/75",
                          )}
                        >
                          {subagentViewSnapshot?.status ?? subagentView.status}
                        </span>
                        <span className="ml-auto hidden text-[10px] text-fg/25 group-hover:inline">
                          press to return
                        </span>
                      </button>
                    ) : null}
                    <AgentChatMessageList
                      key={subagentView ? `subagent-${subagentView.taskId}` : selectedSessionId ?? "chat-draft"}
                      events={selectedEventsForDisplay}
                      subagentTranscript={subagentView ? {
                        messages: subagentTranscript,
                        loading: subagentTranscriptLoading,
                        unsupported: subagentTranscriptUnsupported,
                        snapshotName:
                          subagentView.agentType
                          ?? subagentViewSnapshot?.description
                          ?? subagentView.agentId
                          ?? subagentView.taskId,
                      } : undefined}
                      showStreamingIndicator={!subagentView && turnActive && selectedSession?.status !== "ended"}
                      sessionEnded={selectedSession?.status === "ended"}
                      className="min-h-0 border-0"
                      surfaceMode={surfaceMode}
                      surfaceProfile={surfaceProfile}
                      assistantLabel={assistantLabel}
                      respondingApprovalIds={respondingApprovalIds}
                      pendingApprovalIds={pendingApprovalIds}
                      laneId={laneId}
                      sessionId={selectedSessionId}
                      onInsertDraft={insertComposerDraft}
                      onRevealChatTerminal={(terminal) => {
                        setTerminalDrawerOpen(true);
                        setTerminalRevealRequest({ ...terminal, nonce: ++terminalRevealNonceRef.current });
                      }}
                      onRewindFiles={selectedSession?.provider === "claude" ? rewindFilesFromMessage : undefined}
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
                    {selectedTurnDiffSummaries.length && selectedSessionId ? (
                      <ChatFileChangesPanel
                        summaries={selectedTurnDiffSummaries}
                        sessionId={selectedSessionId}
                      />
                    ) : null}
                    {chatTerminalVisible ? (
                      <ChatTerminalDrawer
                        open={terminalDrawerOpen}
                        onToggle={() => setTerminalDrawerOpen((v) => !v)}
                        laneId={laneId}
                        chatSessionId={selectedSessionId}
                        revealRequest={terminalRevealRequest}
                      />
                    ) : null}
                    {appPanelOpen ? (
                      <div className="shrink-0 border-t border-white/[0.06]">
                        {composerElement}
                      </div>
                    ) : null}
                  </div>

                  {rightPaneDivider}
                  {chatActionsOpen ? renderRightPane(chatActionsPanelContent) : null}
                  {effectiveIosSimulatorOpen ? renderRightPane(iosSimulatorPanelContent) : null}
                  {effectiveAppControlOpen ? renderRightPane(appControlPanelContent) : null}
                  {effectiveCursorCloudPaneOpen ? renderRightPane(cursorCloudPanelContent) : null}
                  {orchestrationPanelOpen && orchestrationPanelContent ? renderRightPane(orchestrationPanelContent) : null}
                </motion.div>
              ) : (
                <motion.div
                  key="empty-state"
                  initial={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.95, transition: { duration: 0.2, ease: "easeIn" } }}
                  className="absolute inset-0 flex min-h-0 overflow-hidden"
                >
                  <div
                    style={splitChatColStyle}
                    className="flex min-w-0 min-h-0 flex-1 basis-0 flex-col overflow-hidden"
                  >
                    <div className={cn(
                      "flex min-h-0 flex-1 items-center justify-center overflow-hidden",
                      appPanelOpen ? "px-3" : "px-6 pb-24",
                    )}>
                      <div className={cn(
                        "flex w-full flex-col items-center gap-4 text-center",
                        appPanelOpen ? null : "max-w-[820px]",
                      )}>
                        <motion.div
                          className={cn(
                            "relative flex w-full min-w-0 items-center justify-center",
                            appPanelOpen ? "max-w-[360px]" : "max-w-[560px]",
                          )}
                          style={{ aspectRatio: "560 / 300" }}
                          exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.3, ease: "easeOut" } }}
                        >
                          <div
                            className="pointer-events-none absolute top-1/2 left-1/2 aspect-square h-full max-h-full max-w-full -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{ background: "var(--color-accent)", opacity: 0.08, filter: "blur(140px)" }}
                          />
                          <img
                            src="./logo.png"
                            alt="ADE"
                            className="relative z-10 h-auto max-h-full w-full max-w-full object-contain"
                            style={{ filter: "drop-shadow(0 0 40px rgba(168,130,255,0.15))" }}
                          />
                        </motion.div>

                        <h2 className="font-sans text-[18px] font-semibold tracking-tight text-fg/80">
                          {isOrchestratorDraft ? "Orchestrate a swarm of agents" : "Start a new conversation"}
                        </h2>

                        {/* Lane selector pill */}
                        {showWorkspaceChrome && draftLaneSelectorLanes.length > 0 && onLaneChange ? (
                          <motion.div
                            className="flex justify-center"
                            exit={{ opacity: 0, transition: { duration: 0.15 } }}
                          >
                            <div className="flex flex-col items-center gap-1.5">
                              <div className="inline-flex items-center gap-2">
                                <LaneCombobox
                                  lanes={draftLaneSelectorLanes}
                                  value={draftLaneSelectorValue}
                                  onChange={handleDraftLaneSelectionChange}
                                  variant="pill"
                                  aria-label="Select lane"
                                />
                                {onOpenShellSession ? (
                                  <SmartTooltip
                                    content={{
                                      label: "Open shell",
                                      description: "Launch a new shell in the selected lane.",
                                    }}
                                  >
                                    <button
                                      type="button"
                                      className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-full border border-white/[0.08] bg-white/[0.04] text-muted-fg/70 transition-colors hover:bg-white/[0.08] hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                                      disabled={!laneId || draftLaunchTargetIsAutoCreate || shellLaunchBusy}
                                      aria-label="Open shell in selected lane"
                                      onClick={() => void launchShellForDraftLane()}
                                    >
                                      <Terminal size={14} weight="regular" />
                                    </button>
                                  </SmartTooltip>
                                ) : null}
                              </div>
                              {draftLaunchTargetIsAutoCreate && autoCreateToolsLane ? (
                                <div className="font-sans text-[10px] leading-4 text-muted-fg/55">
                                  Tools use {autoCreateToolsLane.name} until the lane is created.
                                </div>
                              ) : null}
                            </div>
                          </motion.div>
                        ) : showWorkspaceChrome && laneDisplayLabel ? (
                          <motion.div
                            className="flex items-center gap-2 rounded-full px-4 py-1.5"
                            style={{ background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)" }}
                            exit={{ opacity: 0, transition: { duration: 0.15 } }}
                          >
                            {laneAccentColor ? (
                              <LaneAccentDot lane={{ color: laneAccentColor }} size={8} />
                            ) : (
                              <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: draftAccent }} />
                            )}
                            <span
                              className="text-[11px] font-medium"
                              style={laneAccentColor ? { color: laneAccentColor } : { color: "rgba(255,255,255,0.6)" }}
                            >
                              {laneDisplayLabel}
                            </span>
                          </motion.div>
                        ) : null}

                        {/* Inline composer for empty state (only when sim drawer closed) */}
                        {!appPanelOpen ? (
                          <div className="w-full max-w-[820px]">
                            {composerWithTypographyRoot}
                          </div>
                        ) : null}
                      </div>
                    </div>
                    {appPanelOpen ? (
                      <div className="shrink-0 border-t border-white/[0.06]">
                        {composerWithTypographyRoot}
                      </div>
                    ) : null}
                  </div>
                  {rightPaneDivider}
                  {effectiveIosSimulatorOpen ? renderRightPane(iosSimulatorPanelContent) : null}
                  {effectiveAppControlOpen ? renderRightPane(appControlPanelContent) : null}
                  {effectiveCursorCloudPaneOpen ? renderRightPane(cursorCloudPanelContent) : null}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </ChatSurfaceShell>
      </OrchestratorLeadFrame>
      <RewindFilesConfirmDialog
        state={rewindConfirmDialog}
        sessionId={selectedSessionId}
        onCancel={closeRewindConfirmDialog}
        onConfirm={confirmRewindDialog}
      />
      <ConfirmDialog state={archiveConfirm.state} onClose={archiveConfirm.close} />
    </>
  );
}
