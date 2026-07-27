import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { ArrowLeft, CaretRight, CircleNotch, Cube, Desktop, DeviceMobile, ArrowBendUpRight, DownloadSimple, GitFork, Lightning, Plus, Terminal, TreeStructure, X, type Icon } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  mergeAttachments,
  PARALLEL_CHAT_MAX_ATTACHMENTS,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatRecoverCodexTurnArgs,
  type AgentChatCursorConfigValue,
  type AgentChatDroidPermissionMode,
  type AgentChatExecutionMode,
  type AgentChatEvent,
  type AgentChatEventEnvelope,
  type AgentChatEventHistorySnapshot,
  type AgentChatContextAttachment,
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AgentChatDispatchSteerMode,
  type AgentChatSteerResult,
  type AiProviderConnectionStatus,
  type AiRuntimeConnectionStatus,
  type AgentChatSession,
  type AgentChatSubagentMetadata,
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
  type ClaudeActiveGoal,
  type BuiltInBrowserContextItem,
  type ComputerUseOwnerSnapshot,
  type AppControlContextItem,
  type IosElementContextItem,
  type IosSimulatorDrawerMode,
  type LaneLinearIssue,
  type AiSettingsStatus,
  type OpenProjectBinding,
  type TerminalSessionDetail,
  type TerminalToolType,
} from "../../../shared/types";
import {
  isUnsupportedAgentChatRecoveryActionError,
  providerSupportsHandoffFork,
} from "../../../shared/types/chat";
import { providerDisplayLabel } from "../../../shared/pendingInputLabels";
import { resolveSubagentCapability } from "../../../shared/subagentCapabilities";
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
import { deriveDeterministicLaneNameFromPrompt } from "../../../shared/laneNameFallback";
import { isRuntimeTransportTimeoutError } from "../../../shared/runtimeErrors";
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
  selectSupportedReasoningEffort,
  type LocalProviderFamily,
  type ModelDescriptor,
  type ProviderFamily,
} from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { CURSOR_AVAILABLE_MODE_IDS } from "../../../shared/cursorModes";
import { cn } from "../ui/cn";
import { AgentChatComposer, type ParallelComposerControlSlot } from "./AgentChatComposer";
import { resolveModelDescriptorWithRuntimeCatalog, descriptorsFromAgentChatModelCatalog } from "../shared/ModelPicker/modelCatalog";
import { latestContextUsageInput, toUsageViewModel, type ContextUsageViewModel } from "./usage/contextUsageModel";
import { getSharedRuntimeCatalog } from "../shared/ModelPicker/runtimeCatalogCache";
import { familiesFromStatus } from "../shared/ModelPicker/useProviderAuthStatus";
import {
  AgentChatMessageList,
  type MosaicRenderContext,
} from "./AgentChatMessageList";
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
import { ImportSessionBrowser } from "../terminals/importSessions/ImportSessionBrowser";
import {
  readImportedFrom,
  providerDisplayName as externalProviderDisplayName,
  type ExternalSessionImportResult,
  type ExternalSessionSummary,
} from "../terminals/importSessions/contract";
import { CHAT_SHELL_HEADER_CLASS, ChatSurfaceShell } from "./ChatSurfaceShell";
import { OrchestratorLeadFrame } from "./OrchestratorLeadFrame";
import { OrchestrationPanel } from "../orchestration/OrchestrationPanel";
import { chatChipToneClass, providerChatAccent } from "./chatSurfaceTheme";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";
import { ChatAppControlPanel } from "./ChatAppControlPanel";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import { RewindFilesConfirmDialog, type RewindFilesConfirmDialogState } from "./RewindFilesConfirmDialog";
import { buildRewindPreviewFiles, deriveRewindDiffSummaries } from "./rewindFilesPreview";
import { ChatCursorCloudPanel, type ChatCursorCloudPanelHandle } from "./ChatCursorCloudPanel";
import { CursorCloudInlineLaunch, type CursorCloudInlineLaunchHandle } from "./CursorCloudInlineLaunch";
import { getLaneAccent } from "../lanes/laneColorPalette";
import { openLaneInLanesTabPath } from "../../lib/laneNavigation";
import { ChatTerminalDrawer } from "./ChatTerminalDrawer";
import { deriveChatSubagentSnapshots, deriveTodoItems, deriveTurnDiffSummaries, mergeManagedScheduledWorkSnapshots } from "./chatExecutionSummary";
import { navigateToSpawnedChat } from "./spawnNavigation";
import { deriveMissionSnapshot } from "./chatMission";
import { MissionControlPanel } from "./MissionControlPanel";
import { derivePendingInputRequests, type DerivedPendingInput } from "./pendingInput";
import { findUserMessageForTurn, isParentUserMessage, resolveTurnActive } from "./chatTurnState";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import { ChatActionsDrawerPanel, type ChatActionsTab } from "./ChatActionsDrawerPanel";
import { ChatSourcesPanel } from "./ChatSourcesPanel";
import { CrossMachineHandoffModal } from "./CrossMachineHandoffModal";
import { ChatPrPane } from "./ChatPrPane";
import { ChatPrPaneInsetContext, usePrPaneInsetObserver } from "./chatPrPaneInset";
import { useChatPrAutoPop } from "./useChatPrAutoPop";
import {
  patchChatCompanionUiState,
  readChatCompanionUiState,
} from "./chatCompanionUiState";
import {
  adoptRetainedSession,
  configureChatSessionRetention,
  releaseRetainedChatSession,
  retainChatSession,
} from "./chatSessionRetention";
import { ClaudeLoginPromptButton, createClaudeLoginTerminalInWork } from "../work/ClaudeLoginPromptButton";
import { CHAT_AUTH_RECOVERED_EVENT, CHAT_AUTH_RETRY_REJECTED_EVENT, CHAT_RETRY_AUTH_TURN_EVENT } from "./AgentCliAuthCard";
import { rootAppStoreApi, selectActiveProjectRoot, useAppStore, useRootAppStore } from "../../state/appStore";
import { setLaneNaming } from "../../state/laneNamingStore";
import { buildChatAppearanceRootStyle } from "./chatAppearance";
import { copyLaunchPromptToClipboard } from "../../lib/launchPromptClipboard";
import { shouldShowClaudeChatLoginPrompt } from "../../lib/claudeAuthPrompt";
import { LaneAccentDot } from "../lanes/LaneAccentDot";
import { armLaneBranchDriftWarning, LaneBranchDriftStrip } from "../lanes/LaneBranchDrift";
import {
  effectiveNewLaneBaseSource,
  fetchNewLaneBaseBranches,
  selectDefaultNewLaneBaseRef,
} from "../lanes/newLaneBaseSource";
import { LaneCombobox, AUTO_CREATE_LANE_OPTION_ID } from "../terminals/LaneCombobox";
import {
  buildTrackedCliLaunchCommand,
  LAUNCH_PROFILE_TITLE,
  type CliProvider,
  type WorkPtyLaunchArgs,
  type WorkPtyLaunchResult,
} from "../terminals/cliLaunch";
import { WorkSurfaceHeader } from "../work/WorkSurfaceHeader";
import { WorkActivityModule } from "../usage/ActivityModule";
import { branchNameFromRef } from "../prs/shared/laneBranchTargets";
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
  withDraftLaunchTimeout,
  LAUNCH_PROJECT_CHANGED_MESSAGE,
  type BackgroundLaunchNotice,
  type DraftLaunchJob,
  type DraftLaunchKind,
  type DraftLaunchMode,
  type DraftLaunchSnapshot,
  type NativeControlState,
  type PreparedDraftLaunch,
} from "../../lib/draftLaunchJobs";
import {
  buildHandoffLaunchJobsScopeKey,
  createHandoffLaunchJobId,
  type HandoffLaunchJob,
} from "../../lib/handoffLaunchJobs";
import {
  createAppControlContextInstanceId,
  createBuiltInBrowserContextInstanceId,
  createIosContextInstanceId,
  formatAppControlContextChipsForDisplay,
  formatAppControlContextForPrompt,
  formatBuiltInBrowserContextChipsForDisplay,
  formatBuiltInBrowserContextForPrompt,
  formatIosElementContextChipsForDisplay,
  formatIosElementContextForPrompt,
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
const WORK_START_DRAFT_COMPANION_STATE_KEY = "draft:work-start";
const WORK_START_DRAFT_LAUNCH_SCOPE_ID = "work-start";
const COMPOSER_DRAFT_WRITE_DEBOUNCE_MS = 350;
const CHAT_ACTIONS_AUTOOPEN_FIRED_KEY_PREFIX = "ade.chat.subagentAutoOpenFired";
const CHAT_ACTIONS_AUTOOPEN_FIRED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
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

function handoffProviderDisplayName(provider: string | null | undefined): string {
  return providerDisplayLabel(provider, "this provider");
}

/**
 * One of the two landing cards on the handoff tab (remote / local). Rich icon
 * plate + a single line of copy; the parent owns the disabled/gated states.
 */
function HandoffMenuCard({
  tone,
  icon: Icon,
  title,
  description,
  footnote,
  disabled,
  onClick,
}: {
  tone: "remote" | "local";
  icon: Icon;
  title: string;
  description: string;
  footnote?: string | null;
  disabled?: boolean;
  onClick?: () => void;
}) {
  const toneCls = tone === "remote"
    ? {
        border: "border-sky-300/18",
        wash: "bg-[linear-gradient(150deg,rgba(56,189,248,0.10),rgba(255,255,255,0.014)_62%)]",
        hover: "hover:border-sky-300/34 hover:bg-[linear-gradient(150deg,rgba(56,189,248,0.17),rgba(255,255,255,0.02)_62%)]",
        plate: "border-sky-300/24 bg-sky-400/12 text-sky-100",
      }
    : {
        border: "border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)]",
        wash: "bg-[linear-gradient(150deg,color-mix(in_srgb,var(--chat-accent)_13%,transparent),rgba(255,255,255,0.014)_62%)]",
        hover:
          "hover:border-[color:color-mix(in_srgb,var(--chat-accent)_40%,transparent)] hover:bg-[linear-gradient(150deg,color-mix(in_srgb,var(--chat-accent)_20%,transparent),rgba(255,255,255,0.02)_62%)]",
        plate:
          "border-[color:color-mix(in_srgb,var(--chat-accent)_30%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_15%,transparent)] text-[color:color-mix(in_srgb,var(--chat-accent)_84%,white)]",
      };
  return (
    <button
      type="button"
      onClick={disabled ? undefined : onClick}
      disabled={disabled}
      className={cn(
        "group flex w-full items-start gap-3 rounded-xl border px-3.5 py-3.5 text-left transition-all",
        toneCls.border,
        toneCls.wash,
        disabled ? "cursor-not-allowed opacity-55" : cn("cursor-pointer", toneCls.hover),
      )}
    >
      <div className={cn("grid h-9 w-9 shrink-0 place-items-center rounded-lg border", toneCls.plate)}>
        <Icon size={18} weight="duotone" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[12.5px] font-semibold text-fg/88">{title}</div>
        <div className="mt-1 text-[11px] leading-4 text-fg/52">{description}</div>
        {footnote ? <div className="mt-1.5 text-[10px] leading-4 text-fg/40">{footnote}</div> : null}
      </div>
      {!disabled ? (
        <CaretRight
          size={13}
          className="mt-0.5 shrink-0 text-fg/28 transition-transform group-hover:translate-x-0.5 group-hover:text-fg/45"
        />
      ) : null}
    </button>
  );
}

const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;

type ChatActionsAutoOpenStorage = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

export function getChatActionsAutoOpenStorageKey(sessionId: string): string {
  return `${CHAT_ACTIONS_AUTOOPEN_FIRED_KEY_PREFIX}:${sessionId}`;
}

function encodeChatActionsAutoOpenRecord(nowMs: number): string {
  return JSON.stringify({ firedAt: nowMs });
}

function parseChatActionsAutoOpenFiredAt(raw: string | null): number | "legacy" | null {
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

export function cleanupChatActionsAutoOpenStorage(storage: ChatActionsAutoOpenStorage, nowMs = Date.now()): void {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (key?.startsWith(`${CHAT_ACTIONS_AUTOOPEN_FIRED_KEY_PREFIX}:`)) keys.push(key);
  }
  for (const key of keys) {
    const firedAt = parseChatActionsAutoOpenFiredAt(storage.getItem(key));
    if (firedAt === "legacy") {
      storage.setItem(key, encodeChatActionsAutoOpenRecord(nowMs));
    } else if (firedAt === null || nowMs - firedAt > CHAT_ACTIONS_AUTOOPEN_FIRED_TTL_MS) {
      storage.removeItem(key);
    }
  }
}

function hasChatActionsAutoOpenFired(storage: ChatActionsAutoOpenStorage, sessionId: string, nowMs = Date.now()): boolean {
  const key = getChatActionsAutoOpenStorageKey(sessionId);
  const firedAt = parseChatActionsAutoOpenFiredAt(storage.getItem(key));
  if (firedAt === "legacy") {
    storage.setItem(key, encodeChatActionsAutoOpenRecord(nowMs));
    return true;
  }
  if (firedAt === null) {
    storage.removeItem(key);
    return false;
  }
  if (nowMs - firedAt > CHAT_ACTIONS_AUTOOPEN_FIRED_TTL_MS) {
    storage.removeItem(key);
    return false;
  }
  return true;
}

function transcriptRecordText(record: Record<string, unknown> | null): string | null {
  if (!record) return null;
  for (const key of ["text", "summary", "description", "output", "command", "path", "query"] as const) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return null;
}

function subagentRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function subagentEventTurnId(event: AgentChatEvent): string | null {
  return "turnId" in event && typeof event.turnId === "string" && event.turnId.trim().length
    ? event.turnId.trim()
    : null;
}

function subagentEventItemId(event: AgentChatEvent): string | null {
  return "itemId" in event && typeof event.itemId === "string" && event.itemId.trim().length
    ? event.itemId.trim()
    : null;
}

function subagentEventMessageId(event: AgentChatEvent): string | null {
  return "messageId" in event && typeof event.messageId === "string" && event.messageId.trim().length
    ? event.messageId.trim()
    : null;
}

function stableSubagentMessageId(
  event: AgentChatEvent,
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): string {
  const turnId = subagentEventTurnId(event) ?? "no-turn";
  const itemId = subagentEventItemId(event) ?? subagentEventMessageId(event) ?? message.uuid ?? String(index);
  return `subagent:${message.sessionId}:${turnId}:${itemId}:${event.type}`;
}

function normalizeSubagentEvent(
  event: AgentChatEvent,
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): AgentChatEvent {
  if (event.type === "text") {
    return {
      ...event,
      messageId: event.messageId ?? stableSubagentMessageId(event, message, index),
    };
  }
  if (event.type === "user_message") {
    return {
      ...event,
      messageId: event.messageId ?? stableSubagentMessageId(event, message, index),
    };
  }
  return event;
}

function claudeToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") return block;
        const record = subagentRecord(block);
        return record && typeof record.text === "string" ? record.text : "";
      })
      .filter((value) => value.length > 0)
      .join("\n");
  }
  return "";
}

/**
 * Expand an Anthropic/Claude message ({ role, content[, type:"message"] }) into
 * real transcript events. The Claude Agent SDK's getSubagentMessages returns the
 * raw Anthropic message, whose content blocks (text / thinking / tool_use /
 * tool_result) are the actual subagent transcript — so we surface each block as
 * the matching chat event instead of dropping the whole message into one opaque
 * row.
 */
function expandClaudeTranscriptMessage(
  record: Record<string, unknown>,
  message: AgentChatSubagentTranscriptMessage,
): AgentChatEvent[] {
  const role = typeof record.role === "string" ? record.role : message.type;
  const content = record.content;
  const out: AgentChatEvent[] = [];
  const pushText = (value: string, id: string): void => {
    const trimmed = value.trim();
    if (!trimmed) return;
    out.push(role === "user"
      ? { type: "user_message", text: trimmed, messageId: id }
      : { type: "text", text: trimmed, messageId: id });
  };

  if (typeof content === "string") {
    pushText(content, message.uuid);
  } else if (Array.isArray(content)) {
    content.forEach((block, blockIndex) => {
      const b = subagentRecord(block);
      if (!b) return;
      const blockType = typeof b.type === "string" ? b.type : "";
      const id = `${message.uuid}:${blockIndex}`;
      if (blockType === "text" && typeof b.text === "string") {
        pushText(b.text, id);
      } else if (blockType === "thinking" && typeof b.thinking === "string" && b.thinking.trim().length > 0) {
        out.push({ type: "reasoning", text: b.thinking, itemId: id });
      } else if (blockType === "tool_use") {
        out.push({
          type: "tool_call",
          tool: typeof b.name === "string" && b.name.length > 0 ? b.name : "tool",
          args: b.input ?? {},
          itemId: typeof b.id === "string" && b.id.length > 0 ? b.id : id,
        });
      } else if (blockType === "tool_result") {
        out.push({
          type: "tool_result",
          tool: "",
          result: claudeToolResultText(b.content),
          itemId: typeof b.tool_use_id === "string" && b.tool_use_id.length > 0 ? b.tool_use_id : id,
          status: b.is_error === true ? "failed" : "completed",
        });
      }
    });
  }

  // Nothing structured extracted but the SDK still gave us flat text.
  if (out.length === 0 && typeof message.text === "string" && message.text.trim().length > 0) {
    pushText(message.text, message.uuid);
  }
  return out;
}

function eventsFromSubagentTranscriptMessage(
  message: AgentChatSubagentTranscriptMessage,
  index: number,
): AgentChatEvent[] {
  const record = subagentRecord(message.message);
  // Anthropic/Claude message shape — expand its content blocks. This MUST come
  // before the generic passthrough below: Anthropic messages carry type:"message",
  // which would otherwise be mistaken for an already-formed chat event and render
  // as a blank "event" row.
  if (record && (record.type === "message" || record.role === "assistant" || record.role === "user")) {
    const expanded = expandClaudeTranscriptMessage(record, message)
      .map((event, subIndex) => normalizeSubagentEvent(event, message, index + subIndex));
    if (expanded.length > 0) return expanded;
  }
  // Runtime already handed us a formed chat event (codex / event-history path).
  if (typeof record?.type === "string" && record.type.trim().length > 0 && record.type !== "message") {
    return [normalizeSubagentEvent(record as unknown as AgentChatEvent, message, index)];
  }
  const text = typeof message.text === "string" ? message.text.trim() : transcriptRecordText(record);
  if (!text) return [];
  const event: AgentChatEvent = message.type === "user"
    ? { type: "user_message", text, messageId: message.uuid }
    : { type: "text", text, messageId: message.uuid };
  return [normalizeSubagentEvent(event, message, index)];
}

function subagentMergeKey(event: AgentChatEvent): string | null {
  if (event.type !== "text" && event.type !== "reasoning" && event.type !== "command" && event.type !== "file_change") {
    return null;
  }
  const turnId = subagentEventTurnId(event) ?? "no-turn";
  const itemId = subagentEventItemId(event) ?? subagentEventMessageId(event) ?? "no-item";
  const suffix = event.type === "file_change"
    ? `:${event.path}`
    : event.type === "reasoning" && typeof event.summaryIndex === "number"
      ? `:${event.summaryIndex}`
      : "";
  return `${event.type}:${turnId}:${itemId}${suffix}`;
}

function isCompletedSubagentEvent(event: AgentChatEvent): boolean {
  if ((event.type === "command" || event.type === "file_change") && event.status === "running") {
    return false;
  }
  return true;
}

function mergeAdjacentSubagentEvents(left: AgentChatEvent, right: AgentChatEvent): AgentChatEvent | null {
  if (subagentMergeKey(left) !== subagentMergeKey(right)) return null;
  if (left.type === "text" && right.type === "text") {
    return { ...right, text: `${left.text}${right.text}`, messageId: left.messageId ?? right.messageId };
  }
  if (left.type === "reasoning" && right.type === "reasoning") {
    return { ...right, text: `${left.text}${right.text}` };
  }
  if (left.type === "command" && right.type === "command") {
    if (right.status !== "running") return right;
    return { ...right, output: `${left.output}${right.output}` };
  }
  if (left.type === "file_change" && right.type === "file_change") {
    if (right.status && right.status !== "running") return right;
    return { ...right, diff: `${left.diff}${right.diff}` };
  }
  return null;
}

function coalesceSubagentEventEnvelopes(envelopes: AgentChatEventEnvelope[]): AgentChatEventEnvelope[] {
  const output: AgentChatEventEnvelope[] = [];
  for (const envelope of envelopes) {
    const previous = output[output.length - 1];
    const merged = previous ? mergeAdjacentSubagentEvents(previous.event, envelope.event) : null;
    if (previous && merged) {
      output[output.length - 1] = {
        ...previous,
        event: merged,
        timestamp: envelope.timestamp,
        sequence: envelope.sequence ?? previous.sequence,
      };
    } else {
      output.push(envelope);
    }
  }
  return output;
}

function buildSubagentEventHistory(args: {
  sessionId: string | null;
  subagentId: string;
  subagentName: string;
  prompt: string | null;
  messages: AgentChatSubagentTranscriptMessage[] | null;
  loading: boolean;
  unsupported: boolean;
}): AgentChatEventEnvelope[] {
  const raw = (args.messages ?? [])
    .flatMap((message, index) =>
      eventsFromSubagentTranscriptMessage(message, index).map((event) => ({
        message,
        event,
        mergeKey: subagentMergeKey(event),
        live: message.uuid.startsWith("codex-live:"),
        completed: isCompletedSubagentEvent(event),
      })));

  const completedKeys = new Set(
    raw
      .filter((entry) => entry.mergeKey && !entry.live && entry.completed)
      .map((entry) => entry.mergeKey!),
  );

  const transcriptEntries = raw.filter((entry) => !(entry.live && entry.mergeKey && completedKeys.has(entry.mergeKey)));
  const prompt = args.prompt?.trim() || null;
  const hasPromptMessage = prompt
    ? transcriptEntries.some((entry) => entry.event.type === "user_message")
    : false;

  let sequence = 0;
  const timestampFor = (index: number): string =>
    new Date(Date.UTC(2026, 0, 1, 0, 0, 0, Math.min(index, 999))).toISOString();
  const envelopes: AgentChatEventEnvelope[] = [];
  if (prompt && !hasPromptMessage) {
    envelopes.push({
      sessionId: args.sessionId ?? args.subagentId,
      timestamp: timestampFor(sequence),
      sequence: sequence++,
      event: {
        type: "user_message",
        text: prompt,
        messageId: `subagent:${args.subagentId}:spawn-prompt`,
        deliveryState: "delivered",
        processed: true,
      },
      provenance: {
        messageId: `subagent:${args.subagentId}:spawn-prompt`,
        threadId: args.subagentId,
        role: "user",
        targetKind: "codex_subagent",
      },
    });
  }

  for (const entry of transcriptEntries) {
    // Prefer the event's own id so multiple blocks from one Anthropic message
    // (text + tool calls + results) get distinct provenance instead of colliding
    // on the shared message uuid.
    const messageId = subagentEventItemId(entry.event)
      ?? subagentEventMessageId(entry.event)
      ?? entry.message.uuid
      ?? subagentMergeKey(entry.event)
      ?? `subagent:${args.subagentId}:${sequence}`;
    envelopes.push({
      sessionId: args.sessionId ?? args.subagentId,
      timestamp: timestampFor(sequence),
      sequence: sequence++,
      event: entry.event,
      provenance: {
        messageId,
        threadId: args.subagentId,
        role: entry.message.type === "user" ? "user" : "agent",
        targetKind: "codex_subagent",
      },
    });
  }

  if (envelopes.length === 0 && args.loading) {
    envelopes.push({
      sessionId: args.sessionId ?? args.subagentId,
      timestamp: timestampFor(sequence),
      sequence: sequence++,
      event: {
        type: "activity",
        activity: "working",
        detail: `Loading ${args.subagentName} transcript`,
      },
      provenance: {
        threadId: args.subagentId,
        role: "agent",
        targetKind: "codex_subagent",
      },
    });
  }
  if (envelopes.length === 0 && args.unsupported) {
    envelopes.push({
      sessionId: args.sessionId ?? args.subagentId,
      timestamp: timestampFor(sequence),
      sequence,
      event: {
        type: "error",
        message: "This runtime did not return a subagent transcript.",
      },
      provenance: {
        threadId: args.subagentId,
        role: "agent",
        targetKind: "codex_subagent",
      },
    });
  }

  return coalesceSubagentEventEnvelopes(envelopes);
}
const CHAT_HISTORY_READ_MAX_BYTES = 2_000_000;
const CHAT_HISTORY_PAGE_MAX_BYTES = 256 * 1024;
/**
 * Backoff ladder for silent older-history paging retries. Only after the last
 * rung fails does the message list get a latched, user-visible retry.
 */
const OLDER_HISTORY_RETRY_DELAYS_MS = [800, 2_400];
const MAX_RETAINED_CHAT_SESSION_HISTORIES = 6;
const MAX_SELECTED_CHAT_SESSION_EVENTS = 20_000;
const MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS = 60_000;
const MAX_BACKGROUND_CHAT_SESSION_EVENTS = 1_000;
const MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES = 32 * 1024 * 1024;
const MAX_BACKGROUND_CHAT_SESSION_RESIDENT_BYTES = 2 * 1024 * 1024;
// The view cache holds a reference to the SAME event array the pane already
// keeps resident, so admitting anything the pane can hold costs no extra
// memory while the chat is open and bounds the retained set once it closes.
// Budgeting below the pane's own resident cap only guaranteed that real chats
// were never cached at all (every switch paid a full transcript re-read).
const MAX_AGENT_CHAT_VIEW_CACHE_BYTES_PER_SESSION = MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES;
const MAX_AGENT_CHAT_VIEW_CACHE_BYTES_TOTAL = 128 * 1024 * 1024;
/**
 * How often the active-turn loop re-reads a transcript when NOTHING is arriving.
 * The live `agentChat.onEvent` subscription (kept alive across tab switches by
 * `chatSessionRetention`) is the transport; this loop only exists to notice a
 * silently wedged stream, so it ticks slowly and skips entirely whenever an
 * event landed inside the last interval.
 */
const ACTIVE_TURN_RECOVERY_INTERVAL_MS = 10_000;
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

function autoLaneGenericSuffix(date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join("") + "-" + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function createDeterministicAutoLaneName(prompt: string, options: { genericSuffix?: string | null } = {}): string {
  return deriveDeterministicLaneNameFromPrompt(prompt, options);
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

function draftLaunchPromptSnippet(job: DraftLaunchJob): string {
  const text = job.snapshot.text.trim().replace(/\s+/g, " ");
  if (!text) return job.title;
  return text.length > 44 ? `${text.slice(0, 44)}…` : text;
}

function draftLaunchJobMessage(job: DraftLaunchJob): string {
  const laneSuffix = job.laneName ? ` in ${job.laneName}` : "";
  const warningSuffix = job.warning ? ` ${job.warning}` : "";
  if (job.status === "naming-lane") return `Naming lane with ${formatLocalModelLabel(job.namingModelId ?? job.snapshot.modelId)}...${warningSuffix}`;
  if (job.status === "creating-lane") return `Creating lane for ${draftLaunchKindLabel(job.draftKind)}...${warningSuffix}`;
  if (job.status === "starting-session") return `Starting ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}...${warningSuffix}`;
  if (job.status === "sending-prompt") return `Sending prompt to ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}...${warningSuffix}`;
  if (job.status === "failed") return job.error ? `Launch failed: ${job.error}` : "Launch failed.";
  return job.mode === "background"
    ? `Launched ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}.`
    : `Ready to open ${draftLaunchKindLabel(job.draftKind)}${laneSuffix}.`;
}

function staleDraftLaunchJobMessage(job: DraftLaunchJob): string {
  return `${draftLaunchJobMessage(job)} Still working. You can hide this status while ADE continues in the background.`;
}

/**
 * 3-quadrant reserve. The chat reserves horizontal space for whichever floating
 * side panes are open (when there is room), so the centered transcript + composer
 * re-center in the remaining area rather than leaving an empty gutter opposite an
 * open pane. On a narrow surface it stops reserving so the chat keeps full width
 * (the pane then overlays). Right is preferred over left when space is tight.
 */
const PANE_RESERVE_RIGHT_PX = 276; // 16.5rem pane + 12px gutter
const PANE_RESERVE_LEFT_PX = 276; // 16.5rem pane + 12px gutter
const CHAT_MIN_WIDTH_PX = 360; // recenter the chat as soon as a normal screen allows
// The centered chat column's default width (`--chat-column`, 52rem @ 16px root).
// Used to tell whether a floating pane already fits in the chat's side margin.
const CHAT_COLUMN_PX = 832;
/**
 * Reserve gutter space for the floating panes — but ONLY when they'd otherwise
 * overlap the centered chat column. When the window is wide enough that a pane
 * fits in the chat's natural side margin, reserve nothing so the chat does NOT
 * shift (the pane just overlays the empty margin). When the window is too narrow
 * for the pane to fit beside the column, reserve the pane's width so the chat
 * shifts over instead of being covered. Right is preferred over left when tight.
 */
function computePaneReserve(
  width: number,
  leftOpen: boolean,
  rightOpen: boolean,
): { left: string; right: string } {
  if (width <= 0) return { left: "0px", right: "0px" };
  // Free space on each side of the centered column at full width.
  const naturalSideMargin = Math.max(0, (width - CHAT_COLUMN_PX) / 2);
  let right = 0;
  if (
    rightOpen
    && naturalSideMargin < PANE_RESERVE_RIGHT_PX // pane wouldn't fit in the margin → shift
    && width - PANE_RESERVE_RIGHT_PX >= CHAT_MIN_WIDTH_PX
  ) {
    right = PANE_RESERVE_RIGHT_PX;
  }
  let left = 0;
  if (
    leftOpen
    && naturalSideMargin < PANE_RESERVE_LEFT_PX
    && width - right - PANE_RESERVE_LEFT_PX >= CHAT_MIN_WIDTH_PX
  ) {
    left = PANE_RESERVE_LEFT_PX;
  }
  return { left: `${left}px`, right: `${right}px` };
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
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
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
          const previous = steerMap.get(event.steerId);
          steerMap.set(event.steerId, {
            steerId: event.steerId,
            text: userMessageVisibleText(event),
            attachments: event.attachments ?? previous?.attachments ?? [],
            contextAttachments: event.contextAttachments ?? previous?.contextAttachments ?? [],
          });
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
    } else if (event.type === "command_lifecycle" && event.steerId && event.status !== "queued") {
      steerMap.delete(event.steerId);
      resolvedSteerIds.add(event.steerId);
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
  /**
   * Older-transcript pagination cursor (byte offset of the oldest loaded
   * transcript line). 0 = head reached; null = pagination unavailable.
   */
  historyCursor: number | null;
  cachedAtMs: number;
  estimatedBytes: number;
};

const MAX_AGENT_CHAT_VIEW_CACHE_ENTRIES = 8;
const AGENT_CHAT_VIEW_CACHE_ENABLED = import.meta.env.MODE !== "test";
const agentChatSessionViewCacheBySessionId = new Map<string, AgentChatSessionViewCache>();

function removeAgentChatSessionViewCache(sessionId: string): void {
  agentChatSessionViewCacheBySessionId.delete(sessionId);
}

function estimateAgentChatSessionViewBytes(events: readonly AgentChatEventEnvelope[]): number {
  let estimatedBytes = 0;
  for (const event of events) {
    estimatedBytes += estimatedChatEventResidentBytes(event);
    if (estimatedBytes > MAX_AGENT_CHAT_VIEW_CACHE_BYTES_PER_SESSION) break;
  }
  return estimatedBytes;
}

/** Read without touching LRU recency — safe to call during render. */
function peekAgentChatSessionViewCache(sessionId: string | null | undefined): AgentChatSessionViewCache | null {
  if (!AGENT_CHAT_VIEW_CACHE_ENABLED) return null;
  if (!sessionId) return null;
  return agentChatSessionViewCacheBySessionId.get(sessionId) ?? null;
}

function readAgentChatSessionViewCache(sessionId: string | null | undefined): AgentChatSessionViewCache | null {
  const cached = peekAgentChatSessionViewCache(sessionId);
  if (!cached || !sessionId) return null;
  agentChatSessionViewCacheBySessionId.delete(sessionId);
  agentChatSessionViewCacheBySessionId.set(sessionId, cached);
  return cached;
}

function writeAgentChatSessionViewCache(
  sessionId: string,
  events: AgentChatEventEnvelope[],
  derived = deriveRuntimeState(events),
  historyCursor: number | null = null,
  maxEvents = MAX_SELECTED_CHAT_SESSION_EVENTS,
  detached = false,
): void {
  if (!AGENT_CHAT_VIEW_CACHE_ENABLED) return;
  // A DETACHED view is skipped, never evicted: it is an older transcript
  // prefix whose live tail was dropped to stay under the resident cap, so
  // restoring it later would render an old slice of the transcript as if it
  // were current. Any previously cached (attached) entry is still coherent and
  // is left in place.
  if (detached) return;
  // Cheap count check first so an oversized list never pays for the byte walk.
  if (events.length > maxEvents) {
    removeAgentChatSessionViewCache(sessionId);
    return;
  }
  const estimatedBytes = estimateAgentChatSessionViewBytes(events);
  if (!shouldCacheAgentChatSessionView(events.length, maxEvents, estimatedBytes)) {
    removeAgentChatSessionViewCache(sessionId);
    return;
  }
  removeAgentChatSessionViewCache(sessionId);
  agentChatSessionViewCacheBySessionId.set(sessionId, {
    events,
    turnActive: derived.turnActive,
    pendingInputs: derived.pendingInputs,
    pendingSteers: derived.pendingSteers,
    historyCursor,
    cachedAtMs: Date.now(),
    estimatedBytes,
  });
  // Total bytes are recomputed from the live entries on each write (the map is
  // capped at a handful of entries), so no running counter can drift.
  const evictions = selectAgentChatSessionViewEvictions(
    [...agentChatSessionViewCacheBySessionId].map(([id, entry]) => ({
      sessionId: id,
      estimatedBytes: entry.estimatedBytes,
    })),
  );
  for (const evicted of evictions) removeAgentChatSessionViewCache(evicted);
}

/**
 * Choose which cached views to drop so the cache stays under both the entry
 * count and the total byte ceiling. The cache map is insertion-ordered by
 * recency (see `readAgentChatSessionViewCache`), so `entriesOldestFirst` is
 * simply its iteration order and eviction is oldest-first.
 */
export function selectAgentChatSessionViewEvictions(
  entriesOldestFirst: readonly { sessionId: string; estimatedBytes: number }[],
  maxEntries: number = MAX_AGENT_CHAT_VIEW_CACHE_ENTRIES,
  maxBytes: number = MAX_AGENT_CHAT_VIEW_CACHE_BYTES_TOTAL,
): string[] {
  let entryCount = entriesOldestFirst.length;
  let totalBytes = entriesOldestFirst.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
  const evicted: string[] = [];
  for (const entry of entriesOldestFirst) {
    if (entryCount <= maxEntries && totalBytes <= maxBytes) break;
    evicted.push(entry.sessionId);
    entryCount -= 1;
    totalBytes -= entry.estimatedBytes;
  }
  return evicted;
}

/**
 * Admission test for the module-level chat view cache.
 *
 * The only event-count limit that matters is the caller's own resident limit
 * (`maxEvents`): the cache stores a reference to the array the pane already
 * holds, so anything the pane can render is cheap to remember. Bytes are still
 * bounded per session. Detachment is not this predicate's business — the writer
 * returns early for a detached view (see `writeAgentChatSessionViewCache`).
 */
export function shouldCacheAgentChatSessionView(
  eventCount: number,
  maxEvents: number,
  estimatedBytes: number,
): boolean {
  return eventCount <= maxEvents
    && estimatedBytes <= MAX_AGENT_CHAT_VIEW_CACHE_BYTES_PER_SESSION;
}

function deleteAgentChatSessionViewCache(sessionId: string): void {
  if (!AGENT_CHAT_VIEW_CACHE_ENABLED) return;
  removeAgentChatSessionViewCache(sessionId);
}

/**
 * Drop cached views for sessions that no longer exist for their owner (deleted,
 * archived, or belonging to a project/lane that has gone away).
 *
 * The cache is module-level and outlives any single pane, so without this a
 * closed project's transcripts sit resident until eight newer chats push them
 * out. Deliberately explicit rather than tied to project teardown: the entries
 * carry no project key, so the only honest signal is "this session is gone".
 */
export function clearAgentChatSessionViewCacheForSessions(
  sessionIds: Iterable<string>,
  keepSessionIds: readonly (string | null | undefined)[] = [],
): string[] {
  const cleared: string[] = [];
  for (const sessionId of sessionIds) {
    if (!sessionId) continue;
    if (keepSessionIds.includes(sessionId)) continue;
    if (agentChatSessionViewCacheBySessionId.delete(sessionId)) cleared.push(sessionId);
  }
  return cleared;
}

/**
 * Which of a pane's previously-known sessions have left its roster.
 *
 * Pane-scoped on purpose: several panes share the module cache (Work tiles),
 * so "not in MY roster" is not evidence a session is dead — only "was mine, is
 * no longer mine" is. Anything still selected/locked is never reported, so a
 * roster that is momentarily empty (a refresh in flight) cannot evict the chat
 * the user is reading.
 */
export function selectDepartedChatSessionViewCacheSessions(
  previousSessionIds: Iterable<string>,
  liveSessionIds: ReadonlySet<string>,
  keepSessionIds: readonly (string | null | undefined)[] = [],
): string[] {
  const departed: string[] = [];
  for (const sessionId of previousSessionIds) {
    if (!sessionId || liveSessionIds.has(sessionId)) continue;
    if (keepSessionIds.includes(sessionId)) continue;
    departed.push(sessionId);
  }
  return departed;
}

type LastLaunchConfig = {
  version: 1;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  executionMode: AgentChatExecutionMode;
  controls: NativeControlState;
  updatedAt: string;
};

type ComposerDraftStorageSnapshot = {
  version: 1;
  text: string;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  executionMode: AgentChatExecutionMode;
  controls: NativeControlState;
  attachments: AgentChatFileRef[];
  contextAttachments: AgentChatContextAttachment[];
  iosContextItems: IosElementContextItem[];
  appControlContextItems: AppControlContextItem[];
  builtInBrowserContextItems: BuiltInBrowserContextItem[];
  draftLaunchTargetId: string | null;
  updatedAt: string;
};

type ParallelModelRowState = NativeControlState & {
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  executionMode: AgentChatExecutionMode;
};

type WorkDraftLaunchKind = "chat" | "cli";
type WorkDraftStorageKind = WorkDraftLaunchKind | "work-start";

// Orchestrator is an orthogonal boolean now, so every launch kind shares the
// single "work-start" bucket — prompt/model/lane persist across chat↔cli↔orchestrator.
function normalizeWorkDraftStorageKind(): WorkDraftStorageKind {
  return "work-start";
}

function resolveWorkDraftStorageKind(workDraftKind: WorkDraftLaunchKind | WorkDraftStorageKind): WorkDraftStorageKind {
  return workDraftKind === "work-start" ? "work-start" : normalizeWorkDraftStorageKind();
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
  const { modelId: _, reasoningEffort: _re, fastMode: _fm, executionMode: _em, ...native } = slot;
  return native;
}

function cloneParallelSlotFromComposer(args: {
  native: NativeControlState;
  modelId: string;
  reasoningEffort: string | null;
  fastMode: boolean;
  executionMode: AgentChatExecutionMode;
}): ParallelModelRowState {
  return {
    ...args.native,
    cursorConfigValues: { ...args.native.cursorConfigValues },
    modelId: args.modelId,
    reasoningEffort: args.reasoningEffort,
    fastMode: args.fastMode,
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
  // AGI orchestrator is read-only at the top level → closest legacy mode is plan.
  if (mode === "agi") return "plan";
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
  { value: "default", label: "Manual" },
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
  { value: "agi", label: "AGI (orchestrator)" },
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
  modelId?: string | null;
}): string | null {
  const descriptor = args.modelId
    ? resolveModelDescriptorWithRuntimeCatalog(args.modelId) ?? getModelById(args.modelId)
    : undefined;
  return selectSupportedReasoningEffort({
    tiers: args.tiers,
    preferred: args.preferred,
    advertisedDefault: descriptor?.defaultReasoningEffort,
    fallback: args.modelId?.toLowerCase().includes("fable") ? "high" : null,
  });
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

const chatEventResidentSizeCache = new WeakMap<AgentChatEventEnvelope, number>();

function estimatedChatEventResidentBytes(event: AgentChatEventEnvelope): number {
  const cached = chatEventResidentSizeCache.get(event);
  if (cached !== undefined) return cached;
  let eventBytes: number;
  try {
    eventBytes = JSON.stringify(event).length * 2;
  } catch {
    eventBytes = Number.POSITIVE_INFINITY;
  }
  chatEventResidentSizeCache.set(event, eventBytes);
  return eventBytes;
}

function trimChatEventHistory(
  events: AgentChatEventEnvelope[],
  maxEvents: number,
  maxBytes = Number.POSITIVE_INFINITY,
): AgentChatEventEnvelope[] {
  const countStart = Math.max(0, events.length - maxEvents);
  if (!Number.isFinite(maxBytes)) {
    return countStart > 0 ? events.slice(countStart) : events;
  }
  let estimatedBytes = 0;
  let byteStart = events.length;
  for (let index = events.length - 1; index >= countStart; index -= 1) {
    const eventBytes = estimatedChatEventResidentBytes(events[index]!);
    if (byteStart < events.length && estimatedBytes + eventBytes > maxBytes) break;
    estimatedBytes += eventBytes;
    byteStart = index;
  }
  const start = Math.max(countStart, byteStart);
  return start > 0 ? events.slice(start) : events;
}

function trimChatEventHistoryFromStart(
  events: AgentChatEventEnvelope[],
  maxEvents: number,
  maxBytes = Number.POSITIVE_INFINITY,
): AgentChatEventEnvelope[] {
  const countEnd = Math.min(events.length, maxEvents);
  if (!Number.isFinite(maxBytes)) {
    return countEnd < events.length ? events.slice(0, countEnd) : events;
  }
  let estimatedBytes = 0;
  let byteEnd = 0;
  for (let index = 0; index < countEnd; index += 1) {
    const eventBytes = estimatedChatEventResidentBytes(events[index]!);
    if (byteEnd > 0 && estimatedBytes + eventBytes > maxBytes) break;
    estimatedBytes += eventBytes;
    byteEnd = index + 1;
  }
  const end = Math.min(countEnd, byteEnd);
  return end < events.length ? events.slice(0, end) : events;
}

function stableSessionDelayOffset(sessionId: string): number {
  let hash = 0;
  for (let index = 0; index < sessionId.length; index += 1) {
    hash = ((hash * 31) + sessionId.charCodeAt(index)) >>> 0;
  }
  return hash;
}

const chatEventDedupKeyCache = new WeakMap<AgentChatEventEnvelope, string>();

function chatEventDedupKey(entry: AgentChatEventEnvelope): string {
  const cached = chatEventDedupKeyCache.get(entry);
  if (cached !== undefined) return cached;
  const key = `${entry.timestamp}#${entry.event.type}#${JSON.stringify(entry.event)}`;
  chatEventDedupKeyCache.set(entry, key);
  return key;
}

/**
 * Append a BATCH of live envelopes into the module-level view cache while no
 * pane is mounted for the session (see `chatSessionRetention`).
 *
 * This is deliberately the SAME write path the pane's live flush uses — dedupe
 * by `chatEventDedupKey`, trim by the selected-session resident caps, cache via
 * `writeAgentChatSessionViewCache` — and it stores `deriveRuntimeState`'s raw
 * scalars. It must not apply `resolveTurnActive`: that policy belongs to the
 * pane's hydration (`applyCachedSessionView`), so terminal transcript evidence
 * still beats a stale cached `turnActive: true` on adoption.
 *
 * Batched for the same reason the pane's own flush is: every one of the walks
 * below is O(transcript), and the resident cap is tens of thousands of events.
 * The dedupe `Set`, the trim, the derivation and the byte estimate are each
 * paid ONCE per flush — per-envelope would make a hidden chat more expensive
 * than the visible one.
 *
 * Detached views are skipped: their live tail was already dropped, so appending
 * to them would splice a current event onto an old transcript window.
 */
function appendRetainedChatSessionEvents(
  sessionId: string,
  envelopes: readonly AgentChatEventEnvelope[],
): void {
  if (!envelopes.length) return;
  const cached = peekAgentChatSessionViewCache(sessionId);
  if (!cached) return;
  const seen = new Set<string>();
  for (const entry of cached.events) seen.add(chatEventDedupKey(entry));
  const fresh: AgentChatEventEnvelope[] = [];
  for (const envelope of envelopes) {
    const key = chatEventDedupKey(envelope);
    // Dedupes against the batch itself too — the bridge can redeliver.
    if (seen.has(key)) continue;
    seen.add(key);
    fresh.push(envelope);
  }
  if (!fresh.length) return;
  const merged = trimChatEventHistory(
    [...cached.events, ...fresh],
    MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
    MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES,
  );
  writeAgentChatSessionViewCache(
    sessionId,
    merged,
    deriveRuntimeState(merged),
    cached.historyCursor,
    MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS,
  );
}

configureChatSessionRetention({
  subscribe: (listener) => {
    const onEvent = window.ade?.agentChat?.onEvent;
    if (typeof onEvent !== "function") return () => undefined;
    return onEvent(listener);
  },
  appendEvents: appendRetainedChatSessionEvents,
});

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
  const existingIndexByKey = new Map<string, number>();
  for (let index = 0; index < existing.length; index += 1) {
    const entry = existing[index]!;
    const key = chatEventDedupKey(entry);
    if (!existingByKey.has(key)) existingByKey.set(key, entry);
    if (!existingIndexByKey.has(key)) existingIndexByKey.set(key, index);
  }
  const parsedKeys = new Set<string>();
  const normalizedParsed = parsed.map((entry) => {
    const key = chatEventDedupKey(entry);
    parsedKeys.add(key);
    return existingByKey.get(key) ?? entry;
  });
  let firstOverlapIndex = -1;
  for (const entry of parsed) {
    const index = existingIndexByKey.get(chatEventDedupKey(entry)) ?? -1;
    if (index >= 0 && (firstOverlapIndex < 0 || index < firstOverlapIndex)) {
      firstOverlapIndex = index;
    }
  }
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
  const olderPrefix = firstOverlapIndex > 0
    ? existing.slice(0, firstOverlapIndex).filter((entry) => !parsedKeys.has(chatEventDedupKey(entry)))
    : [];
  const merged = olderPrefix.length || tail.length
    ? [...olderPrefix, ...normalizedParsed, ...tail]
    : normalizedParsed;
  if (merged.length === existing.length && merged.every((entry, index) => entry === existing[index])) {
    return existing;
  }
  return merged;
}

/**
 * Prepend an older transcript page to the in-memory event list, dropping
 * page entries that already exist at the seam (the hydrated tail merges the
 * disk transcript with the live ring buffer, so the byte window ending at
 * the cursor can overlap the oldest in-memory entries).
 *
 * Returns `existing` unchanged when the page contributes nothing new.
 */
export function prependOlderChatHistoryPage(
  older: AgentChatEventEnvelope[],
  existing: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (!older.length) return existing;
  if (!existing.length) return older.slice();
  // Overlap is only possible at the seam — dedupe against the oldest slice of
  // the loaded list instead of hashing all (potentially 20k) entries.
  const seamWindow = Math.min(existing.length, older.length + 64);
  const seamKeys = new Set<string>();
  for (let index = 0; index < seamWindow; index += 1) {
    seamKeys.add(chatEventDedupKey(existing[index]!));
  }
  const fresh = older.filter((entry) => !seamKeys.has(chatEventDedupKey(entry)));
  if (!fresh.length) return existing;
  return [...fresh, ...existing];
}

export function mergeOlderChatHistoryPageWithCap(args: {
  older: AgentChatEventEnvelope[];
  existing: AgentChatEventEnvelope[];
  maxEvents: number;
  maxBytes?: number;
}): { events: AgentChatEventEnvelope[]; hitResidentCap: boolean } {
  const merged = prependOlderChatHistoryPage(args.older, args.existing);
  // The user explicitly asked to move toward the transcript head. Preserve
  // that newly-loaded prefix and evict the newest tail when the selected
  // history window reaches its resident cap. AgentChatPane then treats the
  // view as detached until "Jump to latest" rehydrates the current tail.
  const events = trimChatEventHistoryFromStart(merged, args.maxEvents, args.maxBytes);
  return {
    events,
    hitResidentCap: events.length < merged.length,
  };
}

/**
 * Seed the older-history pagination cursor from a history snapshot.
 *
 * `hasOlderHistory` is authoritative when the runtime sends it: the main
 * service derives it from the tail READ (transcript/window truncation), not
 * from envelope identity. A `false` therefore means there is genuinely nothing
 * older, and we must return 0 even when a non-zero `tailStartOffset` is
 * reported — otherwise the message list offers a "load earlier messages"
 * affordance that can only ever fail. Older remote runtimes omit the field;
 * those fall back to the legacy offset-only rule.
 */
export function resolveSnapshotHistoryCursor(snapshot: {
  hasOlderHistory?: boolean | null;
  tailStartOffset?: number | null;
}): number {
  if (snapshot.hasOlderHistory === false) return 0;
  return typeof snapshot.tailStartOffset === "number" && snapshot.tailStartOffset > 0
    ? snapshot.tailStartOffset
    : 0;
}

/**
 * The session id whose transcript must be on screen RIGHT NOW.
 *
 * `selectedSessionId` is internal state synced from props in an effect, so it
 * trails prop-driven selection by a render: rendering from it paints the
 * OUTGOING chat's transcript for a frame after the pane is pointed somewhere
 * else. The incoming prop wins whenever the two disagree — a locked pane
 * always renders its locked chat, and an `initialSessionId` that the sync
 * effect has not applied yet renders immediately. Once applied, in-pane
 * selection (tabs, new chat) owns the value again.
 */
export function resolveRenderedChatSessionId(args: {
  lockSessionId?: string | null;
  initialSessionId?: string | null;
  appliedInitialSessionId: string | null;
  selectedSessionId: string | null;
}): string | null {
  if (args.lockSessionId) return args.lockSessionId;
  if (args.initialSessionId && args.appliedInitialSessionId !== args.initialSessionId) {
    return args.initialSessionId;
  }
  return args.selectedSessionId;
}

export type ChatHistoryMissAction =
  /** Runtime unreachable: keep everything, retry later, show a catch-up hint. */
  | "sync-pending"
  /** Authoritative miss but the user is looking at rendered events: keep them. */
  | "keep-missing"
  /** Authoritative miss with nothing rendered: safe to drop the empty view. */
  | "clear";

/**
 * Decide what to do when a history read does not return a session.
 *
 * A history miss is NOT automatically "this chat is gone". `unavailable` means
 * the bound runtime could not be reached (remote hop down, machine asleep) and
 * must never destroy rendered state — that is what made a tab or project
 * switch blank an otherwise healthy chat. Even an authoritative
 * `sessionFound: false` only earns a wipe when nothing is currently rendered;
 * blanking a transcript the user is reading is strictly worse than leaving a
 * stale-but-real one on screen.
 */
export function resolveChatHistoryMissAction(args: {
  unavailable?: boolean;
  hasRenderedEvents: boolean;
}): ChatHistoryMissAction {
  if (args.unavailable === true) return "sync-pending";
  return args.hasRenderedEvents ? "keep-missing" : "clear";
}

/**
 * Compute the next older-history cursor after a page response. Returns 0
 * (exhausted) unless the page reports more history AND its startOffset
 * strictly decreased — the strict decrease mirrors the service guarantee and
 * makes client-side paging loops provably terminating.
 */
export function advanceOlderHistoryCursor(
  beforeOffset: number,
  page: { startOffset: number; hasMore: boolean },
): number {
  if (!page.hasMore) return 0;
  if (!Number.isFinite(page.startOffset) || page.startOffset <= 0) return 0;
  if (page.startOffset >= beforeOffset) return 0;
  return page.startOffset;
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

function readStoredFastMode(value: Record<string, unknown>): boolean {
  return value.fastMode === true || value.codexFastMode === true;
}

type LaunchConfigSessionSource = Pick<
  AgentChatSessionSummary,
  | "model"
  | "modelId"
  | "reasoningEffort"
  | "fastMode"
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
    fastMode: modelSupportsFastMode(desc) && source.fastMode === true,
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
    fastMode: modelSupportsFastMode(desc) && readStoredFastMode(value),
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
    fastMode: modelSupportsFastMode(desc) && readStoredFastMode(value),
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
  workDraftKind: "chat" | "cli",
): boolean {
  if (descriptor?.family !== "cursor") return true;
  const availability = descriptor.cursorAvailability;
  if (!availability) return false;
  if (workDraftKind === "cli") return availability.cli === true;
  return availability.sdk === true;
}

function filterCursorModelIdsForDraftKind(
  modelIds: string[],
  workDraftKind: "chat" | "cli",
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

/** Deterministic djb2 hash → stable, collision-resilient mosaic card key suffix. */
function djb2Hash(input: string): string {
  let hash = 5381;
  for (let i = 0; i < input.length; i += 1) {
    hash = ((hash << 5) + hash + input.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
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

/**
 * The first boot model refresh per project root.
 *
 * A remount still calls `refreshAvailableModels()` to repopulate ITS OWN state,
 * but it must not re-gate first paint on that round trip: the ai-status and
 * model-discovery caches underneath are already warm, so `preferencesReady` can
 * flip as soon as this (already settled) promise resolves instead of after a
 * fresh IPC hop. Bounded because a session can only visit so many project roots.
 */
const chatBootModelRefreshByProjectRoot = new Map<string, Promise<unknown>>();
const MAX_CHAT_BOOT_MODEL_REFRESH_ENTRIES = 8;

function hasWarmChatModelCatalog(projectRoot: string | null | undefined): boolean {
  return chatBootModelRefreshByProjectRoot.has(projectRoot ?? "");
}

function rememberChatBootModelRefresh(
  projectRoot: string | null | undefined,
  refresh: Promise<unknown>,
): Promise<unknown> {
  const key = projectRoot ?? "";
  const existing = chatBootModelRefreshByProjectRoot.get(key);
  if (existing) return existing;
  while (chatBootModelRefreshByProjectRoot.size >= MAX_CHAT_BOOT_MODEL_REFRESH_ENTRIES) {
    const oldest = chatBootModelRefreshByProjectRoot.keys().next().value;
    if (typeof oldest !== "string") break;
    chatBootModelRefreshByProjectRoot.delete(oldest);
  }
  chatBootModelRefreshByProjectRoot.set(key, refresh);
  return refresh;
}

/** Test helper — module memo would otherwise leak warm state between cases. */
export function resetChatBootModelRefreshMemoForTests(): void {
  chatBootModelRefreshByProjectRoot.clear();
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
  sessionTitleById,
  hideSessionTabs = false,
  hideNativeControls = false,
  hideModelControls = false,
  hideWorkspaceChrome = false,
  hideSurfaceHeader = false,
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
  orchestratorEnabled = false,
  onLaunchCliSession,
  onOpenShellSession,
  onImportedSession,
  onOpenExistingImportedSession,
  availableLanes,
  onLaneChange,
  onToggleSessionsPane,
  sessionsPaneCollapsed,
  sessionsPaneCount,
  onToggleToolsPane,
  toolsPaneOpen,
  onToggleTerminalPane,
  onOpenTerminalPane,
  terminalPaneOpen,
}: {
  laneId: string | null;
  laneLabel?: string | null;
  initialSessionId?: string | null;
  initialSessionSummary?: AgentChatSessionSummary | null;
  lockSessionId?: string | null;
  /** Full host-surface title index for locked single-session embeddings. */
  sessionTitleById?: ReadonlyMap<string, string>;
  hideSessionTabs?: boolean;
  hideNativeControls?: boolean;
  /** Hide model/reasoning/fast controls when the embedding surface owns them. */
  hideModelControls?: boolean;
  hideWorkspaceChrome?: boolean;
  /** Suppress the WorkSurfaceHeader row entirely (the host surface renders its own header, e.g. the CTO page). */
  hideSurfaceHeader?: boolean;
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
  workDraftKind?: "chat" | "cli";
  /**
   * Orthogonal orchestrator flag: when true the chat draft launches an
   * orchestrator-lead run. Independent of `workDraftKind` so toggling
   * chat↔cli↔orchestrator never splits prompt/model/lane draft state. CLI
   * surfaces force this off (orchestrator has no CLI form).
   */
  orchestratorEnabled?: boolean;
  onLaunchCliSession?: (args: WorkPtyLaunchArgs) => Promise<WorkPtyLaunchResult>;
  onOpenShellSession?: (laneId: string) => void | Promise<void>;
  /**
   * Work draft surface: route the result of importing an external CLI session.
   * Presence of this callback is what enables the "Import session" affordance.
   */
  onImportedSession?: (
    summary: ExternalSessionSummary,
    result: ExternalSessionImportResult,
  ) => void;
  /** Work draft surface: focus an already-imported ADE session instead of re-importing. */
  onOpenExistingImportedSession?: (ref: { kind: "chat" | "cli"; sessionId: string }) => void;
  /** Available lanes for the lane selector in empty state (full `LaneSummary` includes `branchRef` for branch sublines in the menu). */
  availableLanes?: Array<{ id: string; name: string; color?: string | null; branchRef?: string | null; laneType?: string | null }>;
  /** Callback when lane selection changes in empty state */
  onLaneChange?: (laneId: string) => void;
  /** Work tab: far-left session-list expander rendered in this chat's header. */
  onToggleSessionsPane?: () => void;
  sessionsPaneCollapsed?: boolean;
  sessionsPaneCount?: number;
  /** Work tab: far-right Tools-pane toggle rendered in this chat's header. */
  onToggleToolsPane?: () => void;
  toolsPaneOpen?: boolean;
  /** Work tab: terminal pane toggle rendered in this chat's header. */
  onToggleTerminalPane?: () => void;
  /** Work tab: open-only terminal pane action used when a tool reveals a terminal. */
  onOpenTerminalPane?: () => void;
  terminalPaneOpen?: boolean;
}) {
  const projectRoot = useAppStore(selectActiveProjectRoot);
  const projectTransition = useAppStore((s) => s.projectTransition);
  const isRemoteProject = useAppStore((s) => s.projectBinding?.kind === "remote");
  // The originating project's binding, captured per launch so detached draft
  // work can keep targeting the project that started it after the user switches
  // to another project.
  const projectBinding = useAppStore((s) => s.projectBinding);
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
    navigate("/settings?tab=general#linear-connection");
  }, [navigate]);
  const openLaunchPromptClipboardSettings = useCallback(() => {
    navigate("/settings?tab=general#chat-launch-clipboard");
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
  const workDraftStorageKind = normalizeWorkDraftStorageKind();
  const isWorkDraftComposer = forceDraft && embeddedWorkLayout && !lockSessionId && !initialSessionId;
  const draftLaunchConfigLaneScopeId = isWorkDraftComposer ? WORK_START_DRAFT_LAUNCH_SCOPE_ID : laneId;
  const initialWorkDraftLaneIdRef = useRef<string | null>(isWorkDraftComposer ? laneId : null);
  const legacyWorkDraftLaneId = isWorkDraftComposer ? initialWorkDraftLaneIdRef.current : null;
  const initialNativeControls = useMemo(() => defaultNativeControls(surfaceProfile), [surfaceProfile]);
  const lastLaunchConfigStorageKeys = useMemo(() => {
    const primary = launchConfigStorageKeys({
      projectRoot,
      laneId: draftLaunchConfigLaneScopeId,
      surfaceProfile,
      workDraftKind: workDraftStorageKind,
    });
    const legacy = legacyWorkDraftLaneId
      ? launchConfigStorageKeys({
          projectRoot,
          laneId: legacyWorkDraftLaneId,
          surfaceProfile,
          workDraftKind: workDraftStorageKind,
        })
      : [];
    return [...new Set([...primary, ...legacy])];
  }, [draftLaunchConfigLaneScopeId, legacyWorkDraftLaneId, projectRoot, surfaceProfile, workDraftStorageKind]);
  const lastLaunchConfigStorageKey = lastLaunchConfigStorageKeys[0]!;
  const draftLaunchConfigScopeKey = useMemo(
    () => `${projectRoot ?? "project"}:${draftLaunchConfigLaneScopeId ?? "no-lane"}:${surfaceProfile}:${workDraftStorageKind}`,
    [draftLaunchConfigLaneScopeId, projectRoot, surfaceProfile, workDraftStorageKind],
  );
  const draftLaunchJobsScopeKey = useMemo(
    () => [
      "draft-launch-jobs",
      // Partition by the project BINDING, not just projectRoot: jobs now live in
      // the shared root store, and two remote targets can have the same rootPath
      // (e.g. /home/user/project on two machines). Without the binding key,
      // switching remote A → B could surface A's ready/failed job against B.
      projectBinding?.key ?? (projectRoot?.trim() || "project"),
      laneId ?? "no-lane",
      surfaceProfile,
      workDraftStorageKind,
    ].map(encodeURIComponent).join(":"),
    [laneId, projectBinding?.key, projectRoot, surfaceProfile, workDraftStorageKind],
  );
  // Draft-launch job state lives in the ROOT store, not the project-scoped
  // store. A launch can outlive the pane (and its project surface) that started
  // it: switching to another remote project tears down the originating
  // project's scoped store entirely (App.tsx mounts only the active remote
  // surface), which would otherwise drop the in-flight job with no trace. The
  // root store survives that teardown, so the job re-surfaces (and ready jobs
  // auto-open / failures show a Restore) when the user returns. The scope key
  // is already projectRoot-keyed, so jobs stay correctly partitioned per
  // project. Reads (useRootAppStore / rootAppStoreApi.getState) and writes
  // (rootAppStoreApi.getState().setDraftLaunchJobs) both target the root store.
  const draftLaunchJobs = useRootAppStore((s) => s.draftLaunchJobsByScope[draftLaunchJobsScopeKey] ?? EMPTY_DRAFT_LAUNCH_JOBS);
  const setDraftLaunchJobs = useCallback((
    next: DraftLaunchJob[] | ((prev: DraftLaunchJob[]) => DraftLaunchJob[]),
  ) => {
    rootAppStoreApi.getState().setDraftLaunchJobs(draftLaunchJobsScopeKey, next);
  }, [draftLaunchJobsScopeKey]);
  const handoffLaunchJobsScopeKey = useMemo(
    () => buildHandoffLaunchJobsScopeKey({ projectBinding, projectRoot }),
    [projectBinding, projectRoot],
  );
  const setHandoffLaunchJobs = useCallback((
    next: HandoffLaunchJob[] | ((prev: HandoffLaunchJob[]) => HandoffLaunchJob[]),
  ) => {
    rootAppStoreApi.getState().setHandoffLaunchJobs(handoffLaunchJobsScopeKey, next);
  }, [handoffLaunchJobsScopeKey]);
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
  const initialCompanionStateKey = lockSessionId
    ?? initialSessionId
    ?? (isWorkDraftComposer
      ? WORK_START_DRAFT_COMPANION_STATE_KEY
      : laneId ? `draft:${laneId}` : "draft");
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
  // Older-transcript pagination: byte-offset cursor (line start) where the
  // oldest loaded transcript window begins. 0 = head reached; missing key =
  // pagination unavailable (no truncated transcript / old runtime).
  const [olderHistoryCursorBySession, setOlderHistoryCursorBySession] = useState<Record<string, number>>({});
  const [olderHistoryLoadingBySession, setOlderHistoryLoadingBySession] = useState<Record<string, boolean>>({});
  const [olderHistoryErrorBySession, setOlderHistoryErrorBySession] = useState<Record<string, string | null>>({});
  // Set when a history read could not reach the session's bound runtime. The
  // rendered transcript is kept as-is (it is real, just possibly behind) and a
  // later pass renders a catch-up hairline from this flag.
  const [syncPendingBySession, setSyncPendingBySession] = useState<Record<string, boolean>>({});
  const [turnActiveBySession, setTurnActiveBySession] = useState<Record<string, boolean>>({});
  const [pendingInputsBySession, setPendingInputsBySession] = useState<Record<string, DerivedPendingInput[]>>({});
  const [codexGoalPendingBySession, setCodexGoalPendingBySession] = useState<Record<string, boolean>>({});
  const [respondingApprovalIds, setRespondingApprovalIds] = useState<Set<string>>(new Set());
  const [pendingSteersBySession, setPendingSteersBySession] = useState<Record<string, PendingSteerEntry[]>>({});
  const [modelId, setModelId] = useState<string>("");
  const [modelPickerOpenRequest, setModelPickerOpenRequest] = useState<{
    key: number;
    sessionId: string | null;
    laneId: string | null;
  } | undefined>();
  const modelPickerOpenRequestSessionId = lockSessionId ?? selectedSessionId;
  const modelPickerOpenRequestKey = modelPickerOpenRequest?.sessionId === modelPickerOpenRequestSessionId
    && modelPickerOpenRequest.laneId === laneId
    ? modelPickerOpenRequest.key
    : undefined;
  const handleModelPickerOpenRequestHandled = useCallback(() => {
    setModelPickerOpenRequest(undefined);
  }, []);
  const [runtimeCatalogVersion, setRuntimeCatalogVersion] = useState(0);
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [fastMode, setFastMode] = useState(false);
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
  const [importBrowserOpen, setImportBrowserOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  // Seeded warm: on a remount into a project whose model catalog was already
  // fetched there is nothing left to wait for, and re-gating would stall the
  // first paint of the composer chrome behind a memoized promise.
  const [preferencesReady, setPreferencesReady] = useState(() => hasWarmChatModelCatalog(projectRoot));
  const preferencesProjectRootRef = useRef<string | null | undefined>(projectRoot);
  const [error, setError] = useState<string | null>(null);
  const handoffErrorClearTimerRef = useRef<number | null>(null);
  const [deletingChatSessionId, setDeletingChatSessionId] = useState<string | null>(null);
  const [computerUseSnapshot, setComputerUseSnapshot] = useState<ComputerUseOwnerSnapshot | null>(null);
  const openClaudeLoginInPrimaryLane = useCallback(async () => {
    try {
      await createClaudeLoginTerminalInWork({ navigate });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [navigate]);
  const openProviderSignIn = useCallback((family?: ProviderFamily) => {
    if (family === "anthropic") {
      void openClaudeLoginInPrimaryLane();
      return;
    }
    openAiProvidersSettings();
  }, [openAiProvidersSettings, openClaudeLoginInPrimaryLane]);
  const [chatActionsOpen, setChatActionsOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).chatActionsOpen,
  );
  useEffect(() => () => {
    if (handoffErrorClearTimerRef.current != null) {
      window.clearTimeout(handoffErrorClearTimerRef.current);
      handoffErrorClearTimerRef.current = null;
    }
  }, []);
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
  const hasExternalTerminalPane = Boolean(onToggleTerminalPane || onOpenTerminalPane);
  const openTerminalPanel = useCallback(() => {
    if (onOpenTerminalPane) {
      onOpenTerminalPane();
      return;
    }
    if (onToggleTerminalPane) {
      if (!terminalPaneOpen) onToggleTerminalPane();
      return;
    }
    setTerminalDrawerOpen(true);
  }, [onOpenTerminalPane, onToggleTerminalPane, terminalPaneOpen]);
  const revealChatTerminal = useCallback((terminal: { terminalId: string; ptyId: string; label: string }) => {
    openTerminalPanel();
    if (!hasExternalTerminalPane) {
      setTerminalRevealRequest({ ...terminal, nonce: ++terminalRevealNonceRef.current });
    }
  }, [hasExternalTerminalPane, openTerminalPanel]);
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
  const companionStateKey = selectedSessionId
    ?? (isWorkDraftComposer
      ? WORK_START_DRAFT_COMPANION_STATE_KEY
      : laneId ? `draft:${laneId}` : "draft");
  const legacyWorkDraftCompanionStateKey =
    companionStateKey === WORK_START_DRAFT_COMPANION_STATE_KEY && legacyWorkDraftLaneId
      ? `draft:${legacyWorkDraftLaneId}`
      : null;
  // Left PR floating pane (ADE chats only). Auto-pops on webhook-driven PR
  // changes; shared with the CLI session surface via useChatPrAutoPop.
  // `persistKey` makes open/closed per chat and durable across restarts —
  // declared here because it needs `companionStateKey`.
  const { prPaneOpen, setPrPaneOpen, prPaneDelta } = useChatPrAutoPop(laneId, {
    persistKey: companionStateKey,
  });
  // Measured height of the floating PR pane card, published to the minimap rail
  // through ChatPrPaneInsetContext so it can re-centre in the band left below.
  const prPaneInset = usePrPaneInsetObserver();
  const composerDraftStorageKeyValues = useMemo(() => {
    const primary = composerDraftStorageKeys({
      projectRoot,
      companionStateKey,
      surfaceProfile,
      workDraftKind: workDraftStorageKind,
    });
    const legacy = legacyWorkDraftCompanionStateKey
      ? composerDraftStorageKeys({
          projectRoot,
          companionStateKey: legacyWorkDraftCompanionStateKey,
          surfaceProfile,
          workDraftKind: workDraftStorageKind,
        })
      : [];
    return [...new Set([...primary, ...legacy])];
  }, [companionStateKey, legacyWorkDraftCompanionStateKey, projectRoot, surfaceProfile, workDraftStorageKind]);
  const composerDraftStorageKeyValue = composerDraftStorageKeyValues[0]!;
  const companionHydrationKeyRef = useRef<string | null>(initialCompanionStateKey);
  const composerDraftHydratingRef = useRef(false);
  const composerDraftHydratingTextRef = useRef<string | null>(null);
  const [sessionDelta, setSessionDelta] = useState<{ insertions: number; deletions: number } | null>(null);
  const [sessionMutationKind, setSessionMutationKind] = useState<"model" | "permission" | "computer-use" | null>(null);
  const [promptSuggestionsBySession, setPromptSuggestionsBySession] = useState<Record<string, string>>({});
  const [optimisticOutgoingMessage, setOptimisticOutgoingMessage] = useState<{
    sessionId: string;
    envelope: AgentChatEventEnvelope;
  } | null>(null);
  const [handoffBusy, setHandoffBusy] = useState(false);
  const [handoffModelId, setHandoffModelId] = useState("");
  const [handoffReasoningEffort, setHandoffReasoningEffort] = useState<string | null>(null);
  const [handoffFastMode, setHandoffFastMode] = useState(false);
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
  const [handoffNote, setHandoffNote] = useState("");
  // Two-view handoff tab: the landing menu (remote vs local) and the local
  // handoff surface (fork | brief). Both reset each time the tab is opened.
  const [handoffView, setHandoffView] = useState<"menu" | "local">("menu");
  const [handoffLocalMode, setHandoffLocalMode] = useState<"fork" | "brief">("fork");
  // Brief handoffs may target a different lane (or a freshly created one); fork
  // always stays in the source lane. Seeded to the current lane on tab open.
  const [handoffTargetLaneId, setHandoffTargetLaneId] = useState<string>("");
  // Cross-machine modal owns its own model selection now that the menu no
  // longer preselects one; defaulted to the source session model on tab open.
  const [remoteHandoffModelId, setRemoteHandoffModelId] = useState("");
  const [crossMachineHandoffOpen, setCrossMachineHandoffOpen] = useState(false);
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
  // Measure the chat surface width to drive the 3-quadrant pane reserve.
  const [chatAreaWidth, setChatAreaWidth] = useState(0);
  useEffect(() => {
    const el = shellRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width;
      if (typeof next === "number") setChatAreaWidth(next);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const composerMaxHeightPx = layoutVariant === "grid-tile" ? 144 : null;
  const sessionsRef = useRef<AgentChatSessionSummary[]>(sessions);
  const completionSoundPrevTurnActiveRef = useRef(false);
  const completionSoundArmedRef = useRef(true);
  const projectTransitionBlocksChat = projectTransition != null;

  const appliedInitialSessionIdRef = useRef<string | null>(initialSessionId ?? null);
  const loadedHistoryRef = useRef<Set<string>>(new Set());
  // Sessions an AUTHORITATIVE history read reported as absent while we still
  // had events on screen. We keep rendering those events rather than blanking
  // the pane; the marker is what a later pass surfaces as "chat no longer
  // exists" instead of silently showing a transcript with no runtime behind it.
  const missingHistorySessionsRef = useRef<Set<string>>(new Set());
  /**
   * When the live subscription last delivered anything. The active-turn
   * recovery loop is a STALL DETECTOR, not the transport — if events are
   * arriving there is nothing for a full transcript re-read to recover.
   */
  const lastEventReceivedAtMsRef = useRef(0);
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
  const fastModeUpdateCounterRef = useRef(0);
  const pendingFastModeUpdateRef = useRef<{ sessionId: string; updateId: number; promise: Promise<void> } | null>(null);
  const pendingEventQueueRef = useRef<AgentChatEventEnvelope[]>([]);
  const eventsBySessionRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const turnActiveBySessionRef = useRef<Record<string, boolean>>({});
  const detachedHistorySessionsRef = useRef<Set<string>>(new Set());
  const detachedLiveEventsBySessionRef = useRef<Record<string, AgentChatEventEnvelope[]>>({});
  const olderHistoryCursorRef = useRef<Record<string, number>>({});
  const olderHistoryInFlightRef = useRef<Set<string>>(new Set());
  // Pending silent-retry waits for older-history paging. Tracked so a session
  // switch or unmount can cancel them instead of stranding a timer that
  // resumes work for a chat nobody is looking at.
  const olderHistoryRetryWaitersRef = useRef<Set<{ handle: number; resolve: (proceed: boolean) => void }>>(new Set());
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
  turnActiveBySessionRef.current = turnActiveBySession;
  const promptSuggestion = selectedSessionId ? promptSuggestionsBySession[selectedSessionId] ?? null : null;
  const clearPromptSuggestionForSession = useCallback((sessionId: string | null) => {
    if (!sessionId) return;
    setPromptSuggestionsBySession((prev) => {
      if (!(sessionId in prev)) return prev;
      const next = { ...prev };
      delete next[sessionId];
      return next;
    });
  }, []);
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
    if (!api?.getStatus) {
      setAppControlAvailable(false);
      return;
    }
    if (!laneToolsVisible) {
      setAppControlAvailable(false);
      return;
    }
    if (isRemoteProject && !effectiveAppControlOpen) {
      setAppControlAvailable(false);
      return;
    }
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
    // `prPaneOpen` is owned by useChatPrAutoPop's own persist effect; the patch
    // helper does the read-merge-write, so a drawer toggle can't clobber it.
    patchChatCompanionUiState(companionStateKey, {
      chatActionsOpen,
      chatActionsTab,
      iosSimulatorOpen,
      appControlOpen,
      terminalDrawerOpen,
    });
  }, [appControlOpen, chatActionsOpen, chatActionsTab, companionStateKey, iosSimulatorOpen, terminalDrawerOpen]);

  // Companion state prunes itself on write (see `chatCompanionUiState`). This
  // pane deliberately does NOT drive that: its roster only ever contains chat
  // session ids, while the same localStorage namespace is also written with
  // CLI terminal session ids by `WorkViewArea`, so a "keys I know about" list
  // sourced from here would classify every terminal key as garbage.

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
  const updateComposerDraft = useCallback((value: string) => {
    setDraft(value);
    draftsPerSessionRef.current.set(companionStateKey, value);
    if (value.length > 0) clearPromptSuggestionForSession(selectedSessionId);
  }, [clearPromptSuggestionForSession, companionStateKey, selectedSessionId]);
  const insertComposerDraft = useCallback((value: string) => {
    setDraft((current) => {
      const next = current.trim().length ? `${current.trimEnd()}\n\n${value}` : value;
      draftsPerSessionRef.current.set(companionStateKey, next);
      return next;
    });
    clearPromptSuggestionForSession(selectedSessionId);
  }, [clearPromptSuggestionForSession, companionStateKey, selectedSessionId]);

  const iosSimulatorProjectRoot = useMemo(() => {
    const scopedLaneId = selectedSession?.laneId ?? laneId;
    if (!scopedLaneId) return projectRoot;
    const lane = lanes.find((entry) => entry.id === scopedLaneId);
    return lane?.worktreePath ?? projectRoot;
  }, [laneId, lanes, projectRoot, selectedSession?.laneId]);
  // `selectedSessionId` is internal state synced from props in an effect, so it
  // trails the incoming selection by one render. Deriving the transcript from
  // it painted the OUTGOING chat's events for a beat after the pane was pointed
  // at a different chat. Render against the incoming (prop-derived) id instead:
  // the live event map when it already holds that chat, else its cached view,
  // else nothing — never the previous chat's events.
  const renderedSessionId = resolveRenderedChatSessionId({
    lockSessionId,
    initialSessionId,
    appliedInitialSessionId: appliedInitialSessionIdRef.current,
    selectedSessionId,
  });
  const selectedEvents = renderedSessionId
    ? eventsBySession[renderedSessionId]
      ?? peekAgentChatSessionViewCache(renderedSessionId)?.events
      ?? EMPTY_CHAT_EVENTS
    : EMPTY_CHAT_EVENTS;
  const selectedSyncPending = renderedSessionId ? syncPendingBySession[renderedSessionId] === true : false;
  /**
   * Genuinely cold: a real session with neither a committed event list nor a
   * cached view, i.e. its first transcript read is still in flight. A session
   * that truly has no events commits `[]` and is therefore NOT cold — the
   * difference is exactly "we have nothing yet" vs "there is nothing".
   */
  const selectedChatCold = Boolean(
    renderedSessionId
    && selectedEvents.length === 0
    && !eventsBySession[renderedSessionId]
    && !peekAgentChatSessionViewCache(renderedSessionId),
  );
  const optimisticOutgoingMessageRef = useRef<typeof optimisticOutgoingMessage>(null);
  const selectedEventsForDisplay = useMemo(() => {
    const shouldRenderOptimistic =
      optimisticOutgoingMessage
      && optimisticOutgoingMessage.sessionId === renderedSessionId
      && !hasMatchingCommittedUserMessage(selectedEvents, optimisticOutgoingMessage.envelope);
    const baseEvents = shouldRenderOptimistic
      ? [...selectedEvents, optimisticOutgoingMessage.envelope]
      : selectedEvents;
    const settledSteerIds = new Set(baseEvents.flatMap((envelope) => {
      const event = envelope.event;
      if (
        event.type === "user_message"
        && event.steerId
        && event.deliveryState !== "queued"
      ) {
        return [event.steerId];
      }
      if (
        event.type === "system_notice"
        && event.steerId
        && /\b(?:cancelled|delivering)\b/i.test(event.message)
      ) {
        return [event.steerId];
      }
      return [];
    }));
    const displayEvents = baseEvents.filter((envelope) => {
      const event = envelope.event;
      if (event.type.startsWith("subagent.")) return false;
      // Historical immediate sends were first persisted as queued and then
      // resolved under the same steer id. Once resolved, hide the obsolete
      // queue notice so the transcript cannot contradict the delivered bubble.
      if (
        event.type === "system_notice"
        && event.steerId
        && settledSteerIds.has(event.steerId)
        && /^Message queued\b/i.test(event.message)
      ) {
        return false;
      }
      return true;
    });
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
      sessionId: renderedSessionId ?? "",
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
  }, [optimisticOutgoingMessage, renderedSessionId, selectedEvents, selectedSession?.cursorCloudAgentId, selectedSession?.cursorPromotedTurnId]);
  // Fresh snapshot of the visible transcript for the auth-retry/recovery handlers
  // below, which run from window-event listeners (stale-closure-safe).
  const selectedEventsForDisplayRef = useRef(selectedEventsForDisplay);
  selectedEventsForDisplayRef.current = selectedEventsForDisplay;
  const chatHasMessages = useMemo(
    () => selectedEventsForDisplay.some((env) => env.event.type === "user_message" || env.event.type === "text"),
    [selectedEventsForDisplay],
  );
  const [wakeAwayWindow, setWakeAwayWindow] = useState<{
    sessionId: string;
    lastViewedAtMs: number;
    openedAtMs: number;
    dismissed: boolean;
  } | null>(null);
  const [wakeJumpRequest, setWakeJumpRequest] = useState<{ key: string; requestId: number } | null>(null);
  useEffect(() => {
    if (!selectedSessionId) {
      setWakeAwayWindow(null);
      return;
    }
    const storageKey = `ade.chat.lastViewed.v1:${selectedSessionId}`;
    const openedAtMs = Date.now();
    let lastViewedAtMs = openedAtMs;
    try {
      const storedValue = window.localStorage.getItem(storageKey);
      if (storedValue != null) {
        const stored = Number.parseInt(storedValue, 10);
        if (Number.isFinite(stored) && stored > 0) lastViewedAtMs = stored;
      }
    } catch {
      // Renderer storage is best-effort; a blocked localStorage must not hide chat.
    }
    setWakeAwayWindow({ sessionId: selectedSessionId, lastViewedAtMs, openedAtMs, dismissed: false });
    try {
      window.localStorage.setItem(storageKey, String(openedAtMs));
    } catch {
      // Best-effort only.
    }
    return () => {
      try {
        window.localStorage.setItem(storageKey, String(Date.now()));
      } catch {
        // Best-effort only.
      }
    };
  }, [selectedSessionId]);
  const unattendedWakeTurns = useMemo(() => {
    if (!selectedSessionId || wakeAwayWindow?.sessionId !== selectedSessionId || wakeAwayWindow.dismissed) return [];
    return selectedEventsForDisplay.flatMap((envelope) => {
      const event = envelope.event;
      if (event.type !== "user_message" || !event.metadata?.scheduledWake || !event.turnId) return [];
      const wake = event.metadata.scheduledWake;
      const firedAtMs = Date.parse(wake.firedAt);
      if (
        !Number.isFinite(firedAtMs)
        || firedAtMs <= wakeAwayWindow.lastViewedAtMs
        || firedAtMs > wakeAwayWindow.openedAtMs
      ) return [];
      return [{
        scheduleId: wake.scheduleId,
        turnId: event.turnId,
        reason: wake.reason?.trim() || null,
        firedAtMs,
      }];
    }).sort((left, right) => left.firedAtMs - right.firedAtMs);
  }, [selectedEventsForDisplay, selectedSessionId, wakeAwayWindow]);
  const latestUnattendedOutcome = useMemo(() => {
    const latest = unattendedWakeTurns[unattendedWakeTurns.length - 1];
    if (!latest) return null;
    const text = selectedEventsForDisplay
      .filter((envelope) => envelope.event.type === "text" && envelope.event.turnId === latest.turnId)
      .map((envelope) => envelope.event.type === "text" ? envelope.event.text : "")
      .join("")
      .replace(/\s+/g, " ")
      .trim();
    return (text || latest.reason || selectedSession?.lastOutputPreview || "Scheduled work ran while this chat was closed.")
      .slice(0, 180);
  }, [selectedEventsForDisplay, selectedSession?.lastOutputPreview, unattendedWakeTurns]);
  const dispatchedAuthRecoveryRef = useRef<Set<string>>(new Set());
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
  // Claude goal is owned by the CLI's /goal loop — read-only here. Mirror the
  // Codex derivation: latest claude_goal_updated/cleared wins, else the snapshot.
  const selectedClaudeGoal = useMemo<ClaudeActiveGoal | null>(() => {
    let goalFromEvents: ClaudeActiveGoal | null = null;
    let sawGoalEvent = false;
    for (const envelope of selectedEventsForDisplay) {
      const event = envelope.event;
      if (event.type === "claude_goal_updated") {
        goalFromEvents = event.goal;
        sawGoalEvent = true;
      }
      if (event.type === "claude_goal_cleared") {
        goalFromEvents = null;
        sawGoalEvent = true;
      }
    }
    return sawGoalEvent ? goalFromEvents : (selectedSession?.claudeGoal ?? null);
  }, [selectedEventsForDisplay, selectedSession?.claudeGoal]);
  const cancelQueuedMessageFromReceipt = useCallback((steerId: string) => {
    if (!selectedSessionId) return;
    void window.ade.agentChat
      .cancelDispatchedSteer({ sessionId: selectedSessionId, steerId })
      .catch(() => { /* best-effort: already delivered or unknown steer */ });
  }, [selectedSessionId]);
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  const selectedScheduledWorkSnapshots = useMemo(
    () => mergeManagedScheduledWorkSnapshots(selectedEvents, selectedSession?.scheduledWork),
    [selectedEvents, selectedSession?.scheduledWork],
  );
  // Partition scheduled work into schedule kinds (wakeup/cron/loop/remote_trigger)
  // and background command tasks so the actions pane renders them in distinct
  // sections. Both the drawer and pane variants receive the same partitioned data.
  const selectedScheduleItems = useMemo(
    () => selectedScheduledWorkSnapshots.filter((item) => item.kind !== "background_task"),
    [selectedScheduledWorkSnapshots],
  );
  const selectedBackgroundItems = useMemo(
    () => selectedScheduledWorkSnapshots.filter((item) => item.kind === "background_task"),
    [selectedScheduledWorkSnapshots],
  );
  // Per-runtime subagent capability — the single source of truth for whether
  // clicking a subagent takes over the chat (full transcript) or only opens the
  // inline drawer. Computed from the provider with the same shared resolver the
  // service uses, so renderer and main agree without an IPC round-trip.
  const selectedSubagentCapability = useMemo(
    () => resolveSubagentCapability(selectedSession?.provider ?? null),
    [selectedSession?.provider],
  );
  // Droid AGI mission state (Missions tab). Null unless the session is a Droid
  // orchestrator run that has surfaced mission events — non-AGI chats stay null
  // and the Missions tab never appears.
  const selectedMission = useMemo(() => deriveMissionSnapshot(selectedEvents), [selectedEvents]);
  // Last message the user actually sent in this chat — fed to the composer so
  // ArrowUp on line 1 recalls it (terminal-style).
  const lastSentUserMessage = useMemo(() => {
    for (let i = selectedEvents.length - 1; i >= 0; i -= 1) {
      const event = selectedEvents[i]?.event;
      if (event?.type === "user_message") {
        const text = userMessageVisibleText(event).trim();
        if (text) return text;
      }
    }
    return null;
  }, [selectedEvents]);
  const [killingWorkerIds, setKillingWorkerIds] = useState<ReadonlySet<string>>(() => new Set());
  const killDroidWorker = useCallback(
    (workerSessionId: string) => {
      if (!selectedSessionId || !workerSessionId) return;
      const killWorker = window.ade?.agentChat?.killDroidWorker;
      if (typeof killWorker !== "function") return;
      setKillingWorkerIds((prev) => {
        const next = new Set(prev);
        next.add(workerSessionId);
        return next;
      });
      void killWorker({ sessionId: selectedSessionId, workerSessionId })
        .catch((killError) => {
          // eslint-disable-next-line no-console
          console.error("agentChat.killDroidWorker failed", killError);
        })
        .finally(() => {
          setKillingWorkerIds((prev) => {
            if (!prev.has(workerSessionId)) return prev;
            const next = new Set(prev);
            next.delete(workerSessionId);
            return next;
          });
        });
    },
    [selectedSessionId],
  );
  // The pane is runtime-agnostic — Codex emits subagent_started/progress/result
  // events for delegation and collabToolCall items (spawn_agent, etc.) just
  // like Claude. Gate on whether we have anything to display: snapshots OR an
  // active Codex chat goal (so the pane hosts the goal card even before any
  // subagents are spawned).
  const selectedSubagentPaneAvailable =
    selectedSubagentSnapshots.length > 0
    || selectedScheduledWorkSnapshots.length > 0
    || (selectedSession?.provider === "codex" && Boolean(selectedCodexGoal?.objective));
  // Latest snapshot for the currently drilled-in subagent — keeps the
  // breadcrumb status in sync as the agent transitions running → completed.
  const subagentViewSnapshot = useMemo(() => {
    if (!subagentView) return null;
    // Match by taskId OR agentId: when a subagent completes, its snapshot id can
    // resolve from taskId to agentId (placeholder adoption), which previously made
    // the view "lose" its snapshot and auto-clear — i.e. the transcript vanished
    // the moment the subagent ended. Matching either id keeps the drill-in alive
    // after completion so you can still read a finished subagent's transcript.
    return selectedSubagentSnapshots.find((s) =>
      s.taskId === subagentView.taskId
      || (subagentView.taskId != null && s.agentId === subagentView.taskId)
      || (subagentView.agentId != null && (s.agentId === subagentView.agentId || s.taskId === subagentView.agentId)),
    ) ?? null;
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
  const [subagentMetadata, setSubagentMetadata] = useState<AgentChatSubagentMetadata | null>(null);

  // Drill-in (subagent takeover) view-model. Computed here, before any early
  // return, so the useMemo below is an unconditional hook (react-hooks rules).
  const subagentThreadIdForView = subagentMetadata?.threadId
    ?? subagentView?.agentId
    ?? subagentView?.taskId
    ?? null;
  const subagentNameForView = subagentView
    ? (
      subagentMetadata?.label
      ?? subagentMetadata?.agentNickname
      ?? subagentMetadata?.agentRole
      ?? subagentMetadata?.name
      ?? subagentView.agentType
      ?? subagentViewSnapshot?.description
      ?? subagentView.agentId
      ?? subagentView.taskId
      ?? "Subagent"
    )
    : null;
  const subagentPromptForView = subagentView
    ? subagentMetadata?.prompt ?? subagentViewSnapshot?.description ?? null
    : null;
  const subagentEventsForDisplay = useMemo(() => {
    if (!subagentView) return EMPTY_CHAT_EVENTS;
    return buildSubagentEventHistory({
      sessionId: selectedSessionId,
      subagentId: subagentThreadIdForView ?? subagentView.agentId ?? subagentView.taskId,
      subagentName: subagentNameForView ?? subagentView.agentType ?? subagentView.agentId ?? subagentView.taskId,
      prompt: subagentPromptForView,
      messages: subagentTranscript,
      loading: subagentTranscriptLoading,
      unsupported: subagentTranscriptUnsupported,
    });
  }, [
    selectedSessionId,
    subagentNameForView,
    subagentPromptForView,
    subagentThreadIdForView,
    subagentTranscript,
    subagentTranscriptLoading,
    subagentTranscriptUnsupported,
    subagentView,
  ]);

  useEffect(() => {
    if (!subagentView || !selectedSessionId) {
      setSubagentTranscript(null);
      setSubagentTranscriptLoading(false);
      setSubagentTranscriptUnsupported(false);
      setSubagentMetadata(null);
      return;
    }

    const fetchTranscript = window.ade?.agentChat?.getSubagentTranscript;
    if (typeof fetchTranscript !== "function") {
      setSubagentTranscript(null);
      setSubagentTranscriptUnsupported(true);
      setSubagentMetadata(null);
      return;
    }

    let cancelled = false;
    let tickInFlight = false;
    const isRunning = subagentViewSnapshot?.status === "running";

    const tick = async () => {
      if (tickInFlight) return;
      tickInFlight = true;
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
          setSubagentMetadata(null);
        } else {
          setSubagentTranscriptUnsupported(false);
          setSubagentTranscript(result);
          setSubagentMetadata(result.find((entry) => entry.subagentMetadata)?.subagentMetadata ?? null);
        }
      } catch (error) {
        // Log so debugging is possible; surface as empty transcript rather than
        // crashing the drill-in view. Polling tick will retry on the next
        // interval if the subagent is still running.
        // eslint-disable-next-line no-console
        console.error("agentChat.getSubagentTranscript failed", error);
        if (!cancelled) setSubagentTranscript([]);
      } finally {
        tickInFlight = false;
        if (!cancelled) setSubagentTranscriptLoading(false);
      }
    };

    void tick();
    const intervalId = isRunning ? window.setInterval(() => { void tick(); }, 3000) : null;

    return () => {
      cancelled = true;
      if (intervalId !== null) window.clearInterval(intervalId);
    };
  }, [subagentView, subagentViewSnapshot?.status, selectedSessionId]);

  useEffect(() => {
    if (subagentView && !chatActionsOpen) {
      setSubagentView(null);
    }
  }, [chatActionsOpen, subagentView]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        sessionId?: string | null;
        taskId?: string | null;
      }>).detail ?? {};
      if (detail.sessionId && selectedSessionId && detail.sessionId !== selectedSessionId) return;
      setChatActionsTab("agents");
      setIosSimulatorOpen(false);
      setAppControlOpen(false);
      setCursorCloudPaneOpen(false);
      setChatActionsOpen(true);

      const taskId = typeof detail.taskId === "string" ? detail.taskId : null;
      if (!taskId) return;
      const snapshot = selectedSubagentSnapshots.find((candidate) =>
        candidate.taskId === taskId
        || candidate.agentId === taskId
      );
      if (!snapshot) return;
      setSubagentView({
        taskId: snapshot.taskId,
        agentId: snapshot.agentId ?? null,
        agentType: snapshot.agentType ?? null,
        status: snapshot.status,
        background: snapshot.background ?? false,
      });
    };
    window.addEventListener("ade:chat:open-info", handler);
    return () => window.removeEventListener("ade:chat:open-info", handler);
  }, [selectedSessionId, selectedSubagentSnapshots]);

  // Cheap probe for the subagents panel: does this agent actually have a
  // pullable transcript? It runs the EXACT same fetch the takeover view uses
  // (just limit:1), so it can never disagree with what the takeover would
  // render. The panel only replaces the chat when this resolves true —
  // otherwise it opens an inline details drawer, so the dead "No transcript"
  // takeover page is now unreachable.
  const probeSubagentTranscript = useCallback(
    async (args: { taskId: string; agentId: string | null }): Promise<boolean> => {
      const fetchTranscript = window.ade?.agentChat?.getSubagentTranscript;
      if (typeof fetchTranscript !== "function" || !selectedSessionId) return false;
      try {
        const result = await fetchTranscript({
          sessionId: selectedSessionId,
          agentId: args.agentId ?? args.taskId,
          taskId: args.taskId,
          limit: 1,
        });
        return Array.isArray(result) && result.length > 0;
      } catch {
        return false;
      }
    },
    [selectedSessionId],
  );
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
  const setCodexGoalStatusFromPanel = useCallback(async (
    sessionId: string,
    status: Extract<NonNullable<CodexThreadGoal["status"]>, "active" | "paused" | "blocked" | "complete">,
  ) => {
    setError(null);
    setCodexGoalPendingBySession((prev) => ({ ...prev, [sessionId]: true }));
    try {
      await window.ade.agentChat.codex.setGoalStatus({ sessionId, status });
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
  // affordance, so the panel doesn't keep re-opening every time a new task or
  // subagent appears or the user navigates back to the chat. We only slide it in
  // on the first tracked action within a session — after that, opening is up to
  // the user.
  // Persisted to localStorage so the suppression survives remounts.
  const chatActionsAutoOpenedSessionsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    try {
      cleanupChatActionsAutoOpenStorage(window.localStorage);
    } catch {
      /* localStorage unavailable; fall back to in-memory ref */
    }
  }, []);

  useEffect(() => {
    if (!selectedSessionId) {
      if (chatActionsOpen) setChatActionsOpen(false);
      return;
    }
    const trackedActionCount = selectedSubagentSnapshots.length + selectedTodoItems.length + selectedScheduledWorkSnapshots.length;
    if (trackedActionCount === 0) {
      return;
    }
    if (chatActionsAutoOpenedSessionsRef.current.has(selectedSessionId)) {
      return;
    }
    try {
      if (hasChatActionsAutoOpenFired(window.localStorage, selectedSessionId)) {
        chatActionsAutoOpenedSessionsRef.current.add(selectedSessionId);
        return;
      }
    } catch {
      /* localStorage unavailable; fall back to in-memory ref */
    }
    const markChatActionsAutoOpened = () => {
      chatActionsAutoOpenedSessionsRef.current.add(selectedSessionId);
      try {
        window.localStorage.setItem(
          getChatActionsAutoOpenStorageKey(selectedSessionId),
          encodeChatActionsAutoOpenRecord(Date.now()),
        );
      } catch {
        /* best-effort persistence */
      }
    };
    // Don't consume the once-per-session auto-open until we can actually surface
    // the actions panel. If the chat-actions pane is already open (possibly on a
    // different tab), leave the user where they are and retry when it next closes
    // — otherwise the flag gets burned without the agents panel ever opening,
    // which is exactly why subagents sometimes didn't auto-open (it was runtime-
    // independent; it depended on whether the pane happened to be open already).
    if (chatActionsOpen) {
      if (chatActionsTab === "agents") {
        markChatActionsAutoOpened();
      }
      return;
    }
    markChatActionsAutoOpened();
    setChatActionsTab("agents");
    setIosSimulatorOpen(false);
    setAppControlOpen(false);
    setCursorCloudPaneOpen(false);
    setChatActionsOpen(true);
  }, [chatActionsOpen, chatActionsTab, selectedSessionId, selectedSubagentSnapshots.length, selectedScheduledWorkSnapshots.length, selectedTodoItems.length]);

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
        try {
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
        } finally {
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
      setParallelLaunchBusy(false);
      setParallelLaunchStatus(null);
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
  const showClaudeLoginPrompt = useMemo(() => shouldShowClaudeChatLoginPrompt({
    provider: selectedSession?.provider ?? sessionProvider,
    events: selectedEventsForDisplay,
    turnActive,
    authAvailable: providerConnections?.claude?.authAvailable === true,
  }), [
    providerConnections?.claude?.authAvailable,
    selectedEventsForDisplay,
    selectedSession?.provider,
    sessionProvider,
    turnActive,
  ]);
  // Provider-agnostic context-usage for the composer dial. Codex pushes a live
  // Reduce provider telemetry across compaction boundaries before flattening it
  // into the shared dial view-model. Exact post-compaction snapshots win;
  // stale same-turn cumulative counters are ignored.
  const selectedUsageViewModel = useMemo<ContextUsageViewModel | null>(() => {
    const provider = sessionProvider ?? selectedSession?.provider ?? "";
    const descriptor = modelId ? (resolveModelDescriptorWithRuntimeCatalog(modelId) ?? getModelById(modelId)) : null;
    const fallbackWindow = descriptor?.contextWindow ?? null;
    return toUsageViewModel(
      latestContextUsageInput(selectedEventsForDisplay, provider, selectedSession?.codexTokenUsage),
      fallbackWindow,
    );
  }, [selectedEventsForDisplay, selectedSession?.codexTokenUsage, selectedSession?.provider, sessionProvider, modelId]);

  const [contextCompactionPulse, setContextCompactionPulse] = useState(false);
  const compactionPulseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seenCompactionCompletionRef = useRef<Set<string>>(new Set());
  const lastScannedCompactionSessionRef = useRef<string | null>(null);
  const lastScannedCompactionEventCountRef = useRef(0);
  useEffect(() => {
    if (!selectedSessionId) return;

    if (lastScannedCompactionSessionRef.current !== selectedSessionId) {
      seenCompactionCompletionRef.current.clear();
      lastScannedCompactionEventCountRef.current = selectedEventsForDisplay.length;
      lastScannedCompactionSessionRef.current = selectedSessionId;
      return;
    }

    const startIndex = lastScannedCompactionEventCountRef.current;
    if (startIndex >= selectedEventsForDisplay.length) return;

    for (let index = startIndex; index < selectedEventsForDisplay.length; index += 1) {
      const envelope = selectedEventsForDisplay[index]!;
      const event = envelope.event;
      if (event.type !== "context_compact" || event.state !== "completed") continue;
      const key = `${envelope.timestamp}:${event.compactionId ?? event.turnId ?? ""}`;
      if (seenCompactionCompletionRef.current.has(key)) continue;
      seenCompactionCompletionRef.current.add(key);
      setContextCompactionPulse(true);
      if (compactionPulseTimerRef.current) clearTimeout(compactionPulseTimerRef.current);
      compactionPulseTimerRef.current = setTimeout(() => {
        setContextCompactionPulse(false);
        compactionPulseTimerRef.current = null;
      }, 1800);
    }
    lastScannedCompactionEventCountRef.current = selectedEventsForDisplay.length;
  }, [selectedEventsForDisplay, selectedSessionId]);
  useEffect(() => () => {
    if (compactionPulseTimerRef.current) clearTimeout(compactionPulseTimerRef.current);
  }, []);
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
      modelId: config.modelId,
    }));
    setFastMode(modelSupportsFastMode(desc) && config.fastMode);
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
      setFastMode(false);
      return;
    }
    const nextModelId = session.modelId ?? resolveRegistryModelId(session.model);
    if (nextModelId) {
      setModelId(nextModelId);
    }
    setReasoningEffort(session.reasoningEffort ?? null);
    setFastMode(session.fastMode === true);
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
    orchestratorEnabled && !selectedSessionId
      ? "Describe the orchestration goal..."
      : "Type to vibecode...";
  const messagePlaceholder = presentation?.messagePlaceholder?.trim() || defaultMessagePlaceholder;
  const effectiveMessagePlaceholder = projectTransitionBlocksChat
    ? "Project is switching..."
    : messagePlaceholder;
  const chipsJson = JSON.stringify(presentation?.chips ?? []);
  const resolvedChips = useMemo(() => JSON.parse(chipsJson) as ChatSurfaceChip[], [chipsJson]);
  const selectedSessionImportedProvider = readImportedFrom(selectedSession)?.provider ?? null;
  const headerChips = useMemo<ChatSurfaceChip[]>(() => {
    const chips = [...resolvedChips];
    if (selectedSessionImportedProvider) {
      chips.push({
        label: `Imported · ${externalProviderDisplayName(selectedSessionImportedProvider)}`,
        tone: "muted",
      });
    }
    if (selectedSession?.claudeTag?.trim()) {
      chips.push({ label: selectedSession.claudeTag.trim(), tone: "muted" });
    }
    return chips;
  }, [resolvedChips, selectedSession?.claudeTag, selectedSessionImportedProvider]);

  // Two-way lineage: a spawned child chat shows a "↳ from <spawner>" breadcrumb
  // in its header that navigates back to the parent. Parent title resolves from
  // the loaded session list; falls back to a generic label with the link intact.
  const spawnLineage = useMemo(() => {
    const parentId = selectedSession?.orchestrationParentSessionId?.trim();
    if (!parentId || parentId === selectedSession?.sessionId) return null;
    const parentTitle = sessions.find((s) => s.sessionId === parentId)?.title?.trim() || null;
    return { parentId, parentTitle, spawnKind: selectedSession?.spawnKind ?? null };
  }, [selectedSession?.orchestrationParentSessionId, selectedSession?.sessionId, selectedSession?.spawnKind, sessions]);

  // Resolve a spawned child chat's live title so the Subagents pane's spawned-chat
  // rows read as the chat they open, not the bare runtime name.
  const resolveSpawnedChatTitle = useCallback(
    (id: string): string | null => sessionTitleById?.get(id)?.trim()
      || sessions.find((s) => s.sessionId === id)?.title?.trim()
      || null,
    [sessionTitleById, sessions],
  );

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
    });
    if (modelSelectionConstrained) return filterCursorModelIdsForDraftKind(base, workDraftKind);
    const catalog = getSharedRuntimeCatalog();
    if (!catalog) return filterCursorModelIdsForDraftKind(base, workDraftKind);
    const runtimeIds = descriptorsFromAgentChatModelCatalog(catalog).availableModelIds;
    if (!runtimeIds.length) return filterCursorModelIdsForDraftKind(base, workDraftKind);
    const merged = new Set(base);
    for (const id of runtimeIds) merged.add(id);
    return filterCursorModelIdsForDraftKind([...merged], workDraftKind);
  }, [availableModelIds, availableModelIdsOverride, modelSelectionConstrained, selectedSessionModelId, selectedEvents.length, runtimeCatalogVersion, workDraftKind]);
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
  const cursorCloudApiAvailable = providerConnections?.cursor?.runtimeAvailable === true
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
      const leftLabel = resolveModelDescriptorWithRuntimeCatalog(left)?.displayName ?? left;
      const rightLabel = resolveModelDescriptorWithRuntimeCatalog(right)?.displayName ?? right;
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
    () => (handoffModelId ? (resolveModelDescriptorWithRuntimeCatalog(handoffModelId) ?? null) : null),
    [handoffModelId],
  );
  const handoffTargetProvider = useMemo(
    () => (handoffTargetDescriptor ? resolveProviderGroupForModel(handoffTargetDescriptor) : null),
    [handoffTargetDescriptor],
  );
  // Whether the SOURCE provider exposes a native fork surface at all (claude,
  // codex, opencode, droid). Fork keeps the target in the same provider — the
  // model may still change within it — so the fork model picker is constrained
  // to same-provider models below.
  const handoffForkSupported = providerSupportsHandoffFork(selectedSession?.provider);
  const handoffForkModelFilter = useCallback((descriptor: ModelDescriptor) => {
    const sourceProvider = selectedSession?.provider;
    return Boolean(sourceProvider && resolveProviderGroupForModel(descriptor) === sourceProvider);
  }, [selectedSession?.provider]);
  const handoffForkAvailableModelIds = useMemo(() => {
    const sourceProvider = selectedSession?.provider;
    if (!sourceProvider) return [] as string[];
    return handoffAvailableModelIds.filter((id) => {
      const desc = resolveModelDescriptorWithRuntimeCatalog(id);
      return desc ? resolveProviderGroupForModel(desc) === sourceProvider : false;
    });
  }, [handoffAvailableModelIds, selectedSession?.provider]);
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
  /**
   * Writes a whole `NativeControlState` back into the individual handoff fields.
   * The cross-machine modal edits permissions against the *destination* model,
   * so it needs to hand back a full state rather than poke one provider's field
   * — which provider is even relevant depends on the model it just picked.
   */
  const applyHandoffNativeControls = useCallback((next: NativeControlState) => {
    setHandoffClaudePermissionMode(next.claudePermissionMode);
    setHandoffCodexApprovalPolicy(next.codexApprovalPolicy);
    setHandoffCodexSandbox(next.codexSandbox);
    setHandoffCodexConfigSource(next.codexConfigSource);
    setHandoffOpenCodePermissionMode(next.opencodePermissionMode);
    setHandoffDroidPermissionMode(next.droidPermissionMode);
    setHandoffCursorModeId(next.cursorModeId);
    setHandoffCursorConfigValues(next.cursorConfigValues);
  }, []);
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
  // The cross-machine modal picks its own destination model, so derive its
  // provider independently of the local-handoff picker. Reasoning/permission
  // fields still inherit the source-session-derived handoff defaults.
  const remoteHandoffTargetDescriptor = useMemo(
    () => (remoteHandoffModelId ? (resolveModelDescriptorWithRuntimeCatalog(remoteHandoffModelId) ?? null) : null),
    [remoteHandoffModelId],
  );
  const remoteHandoffTargetProvider = useMemo(
    () => (remoteHandoffTargetDescriptor ? resolveProviderGroupForModel(remoteHandoffTargetDescriptor) : null),
    [remoteHandoffTargetDescriptor],
  );
  const remoteHandoffNativePermissionMode = useMemo((): AgentChatPermissionMode | undefined | null => {
    if (!remoteHandoffTargetProvider) return null;
    return summarizeNativeControls(remoteHandoffTargetProvider, handoffNativeControlState).permissionMode
      ?? undefined;
  }, [remoteHandoffTargetProvider, handoffNativeControlState]);
  const crossMachineHandoffTarget = useMemo(() => ({
    targetModelId: remoteHandoffModelId,
    reasoningEffort: handoffReasoningEffort,
    // Serialize fast mode for exactly the models whose toggle the modal renders
    // (`modelSupportsFastMode`), not a hardcoded provider pair — otherwise a
    // fast-capable Claude model shows a live control that never reaches the
    // capsule, and the destination silently inherits the source's tier.
    ...(remoteHandoffTargetDescriptor && modelSupportsFastMode(remoteHandoffTargetDescriptor)
      ? { fastMode: handoffFastMode }
      : {}),
    claudePermissionMode: handoffClaudePermissionMode,
    codexApprovalPolicy: handoffCodexApprovalPolicy,
    codexSandbox: handoffCodexSandbox,
    codexConfigSource: handoffCodexConfigSource,
    opencodePermissionMode: handoffOpenCodePermissionMode,
    droidPermissionMode: handoffDroidPermissionMode,
    ...(remoteHandoffNativePermissionMode != null ? { permissionMode: remoteHandoffNativePermissionMode } : {}),
    cursorModeId: handoffCursorModeId,
    cursorConfigValues: handoffCursorConfigValues,
  }), [
    handoffClaudePermissionMode,
    handoffCodexApprovalPolicy,
    handoffCodexConfigSource,
    handoffCodexSandbox,
    handoffCursorConfigValues,
    handoffCursorModeId,
    handoffDroidPermissionMode,
    handoffFastMode,
    handoffOpenCodePermissionMode,
    handoffReasoningEffort,
    remoteHandoffModelId,
    remoteHandoffTargetDescriptor,
    remoteHandoffNativePermissionMode,
    remoteHandoffTargetProvider,
  ]);
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
      const residentEvents = eventsBySessionRef.current[lockSessionId] ?? [];
      const nextRunning = residentEvents.length > 0
        ? resolveTurnActive(residentEvents, deriveRuntimeState(residentEvents).turnActive, summary)
        : Boolean(summary?.status === "active" && summary.awaitingInput !== true);
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
      detachedHistorySessionsRef.current.clear();
      detachedLiveEventsBySessionRef.current = {};
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
    detachedLiveEventsBySessionRef.current = pruneSessionRecord(
      detachedLiveEventsBySessionRef.current,
      retainedSessionIds,
    );
    for (const sessionId of [...detachedHistorySessionsRef.current]) {
      if (!retainedSessionIds.has(sessionId)) detachedHistorySessionsRef.current.delete(sessionId);
    }
    olderHistoryCursorRef.current = pruneSessionRecord(olderHistoryCursorRef.current, retainedSessionIds);
    for (const sessionId of [...loadedHistoryRef.current]) {
      if (!retainedSessionIds.has(sessionId)) {
        loadedHistoryRef.current.delete(sessionId);
      }
    }
    setEventsBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    setOlderHistoryCursorBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    setOlderHistoryLoadingBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    setOlderHistoryErrorBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    setSyncPendingBySession((prev) => pruneSessionRecord(prev, retainedSessionIds));
    for (const sessionId of [...missingHistorySessionsRef.current]) {
      if (!retainedSessionIds.has(sessionId)) missingHistorySessionsRef.current.delete(sessionId);
    }
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

  // Record (or remove, when null) the older-history pagination cursor for a
  // session in both the synchronous ref (read by loadOlderHistory) and the
  // render state (drives the message list's "more above" affordance).
  const applyOlderHistoryCursor = useCallback((sessionId: string, cursor: number | null) => {
    if (cursor == null) {
      if (sessionId in olderHistoryCursorRef.current) {
        const next = { ...olderHistoryCursorRef.current };
        delete next[sessionId];
        olderHistoryCursorRef.current = next;
      }
      setOlderHistoryCursorBySession((prev) => {
        if (!(sessionId in prev)) return prev;
        const next = { ...prev };
        delete next[sessionId];
        return next;
      });
      return;
    }
    olderHistoryCursorRef.current = { ...olderHistoryCursorRef.current, [sessionId]: cursor };
    setOlderHistoryCursorBySession((prev) => (
      prev[sessionId] === cursor ? prev : { ...prev, [sessionId]: cursor }
    ));
  }, []);

  const clearSessionView = useCallback((sessionId: string) => {
    // Drop the retention subscription first: it exists only to keep this
    // session's cached view current, and the very next line throws that view
    // away. Leaving it live would hold a subscription (up to the 5 minute TTL)
    // for a chat that is being cleared or has just been deleted.
    releaseRetainedChatSession(sessionId);
    deleteAgentChatSessionViewCache(sessionId);
    detachedHistorySessionsRef.current.delete(sessionId);
    missingHistorySessionsRef.current.delete(sessionId);
    setSyncPendingBySession((prev) => (sessionId in prev ? { ...prev, [sessionId]: false } : prev));
    delete detachedLiveEventsBySessionRef.current[sessionId];
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: [] };
    applyOlderHistoryCursor(sessionId, null);
    setOlderHistoryErrorBySession((prev) => ({ ...prev, [sessionId]: null }));
    setEventsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: [] }));
    setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: [] }));
  }, [applyOlderHistoryCursor]);

  const applyCachedSessionView = useCallback((sessionId: string): boolean => {
    const cached = readAgentChatSessionViewCache(sessionId);
    if (!cached) return false;
    eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: cached.events };
    loadedHistoryRef.current.add(sessionId);
    applyOlderHistoryCursor(sessionId, typeof cached.historyCursor === "number" ? cached.historyCursor : null);
    setEventsBySession((prev) => ({ ...prev, [sessionId]: cached.events }));
    const sessionSummary = sessionsRef.current.find((entry) => entry.sessionId === sessionId)
      ?? (initialSessionSummary?.sessionId === sessionId ? initialSessionSummary : null);
    setTurnActiveBySession((prev) => ({
      ...prev,
      [sessionId]: resolveTurnActive(cached.events, cached.turnActive, sessionSummary),
    }));
    setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: cached.pendingInputs }));
    setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: cached.pendingSteers }));
    return true;
  }, [applyOlderHistoryCursor, initialSessionSummary]);

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
      // Older-history cursor seeded from the snapshot: the byte offset where
      // the hydrated transcript tail began (0 = whole transcript hydrated,
      // or the snapshot authoritatively reports no older history).
      let snapshotHistoryCursor = 0;
      // A history miss must never destroy rendered state unless it is both
      // authoritative AND nothing is on screen. `applyHistoryMiss` centralises
      // that decision so every miss path below behaves identically.
      const applyHistoryMiss = (miss: { unavailable?: boolean }): void => {
        const action = resolveChatHistoryMissAction({
          unavailable: miss.unavailable,
          hasRenderedEvents: (eventsBySessionRef.current[sessionId]?.length ?? 0) > 0,
        });
        // Always clear the loaded flag: every miss is retryable, and leaving
        // the flag set would strand the pane until a new event arrived.
        loadedHistoryRef.current.delete(sessionId);
        if (action === "sync-pending") {
          // The runtime could not be reached. This says nothing about whether
          // the session exists, so keep events, cursors and the view cache
          // exactly as they are and let the next read catch up.
          setSyncPendingBySession((prev) => (prev[sessionId] ? prev : { ...prev, [sessionId]: true }));
          return;
        }
        if (action === "keep-missing") {
          // Authoritative miss, but the user is looking at a real transcript.
          // Mark it rather than blanking the screen.
          missingHistorySessionsRef.current.add(sessionId);
          return;
        }
        clearSessionView(sessionId);
      };
      try {
        if (typeof window.ade.agentChat.getEventHistory === "function") {
          const snapshot: AgentChatEventHistorySnapshot = await window.ade.agentChat.getEventHistory({
            sessionId,
            maxEvents: MAX_SELECTED_CHAT_SESSION_EVENTS,
          });
          if (snapshot?.sessionId === sessionId && snapshot.unavailable === true) {
            applyHistoryMiss({ unavailable: true });
            return;
          }
          if (snapshot?.sessionId === sessionId && snapshot.sessionFound === false) {
            applyHistoryMiss({ unavailable: false });
            return;
          }
          if (snapshot?.sessionId === sessionId && !snapshot.events?.length && snapshot.sessionFound !== true) {
            const summary = await window.ade.agentChat.getSummary({ sessionId }).catch(() => null);
            if (!summary) {
              applyHistoryMiss({ unavailable: snapshot.unavailable });
              return;
            }
          }
          if (snapshot?.events?.length || snapshot?.sessionId === sessionId) {
            parsed = (snapshot.events ?? []).filter((entry) => entry.sessionId === sessionId);
            usedSnapshotPath = true;
            snapshotHistoryCursor = resolveSnapshotHistoryCursor(snapshot);
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
        sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
          ? MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES
          : MAX_BACKGROUND_CHAT_SESSION_RESIDENT_BYTES,
      );

      const derived = deriveRuntimeState(merged);
      const sessionSummary = sessionsRef.current.find((entry) => entry.sessionId === sessionId)
        ?? (initialSessionSummary?.sessionId === sessionId ? initialSessionSummary : null);
      const historyCursor = usedSnapshotPath ? snapshotHistoryCursor : null;
      // A successful hydrate reattaches the view to the live tail, so drop the
      // detached marker BEFORE caching — the merged window is cacheable again.
      detachedHistorySessionsRef.current.delete(sessionId);
      missingHistorySessionsRef.current.delete(sessionId);
      writeAgentChatSessionViewCache(
        sessionId,
        merged,
        derived,
        historyCursor,
        MAX_SELECTED_CHAT_SESSION_EVENTS,
        detachedHistorySessionsRef.current.has(sessionId),
      );
      delete detachedLiveEventsBySessionRef.current[sessionId];
      setSyncPendingBySession((prev) => (prev[sessionId] ? { ...prev, [sessionId]: false } : prev));
      eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: merged };
      applyOlderHistoryCursor(sessionId, historyCursor);
      setOlderHistoryErrorBySession((prev) => (
        prev[sessionId] ? { ...prev, [sessionId]: null } : prev
      ));
      setEventsBySession((prev) => ({ ...prev, [sessionId]: merged }));
      setTurnActiveBySession((prev) => ({
        ...prev,
        [sessionId]: resolveTurnActive(merged, derived.turnActive, sessionSummary),
      }));
      setPendingInputsBySession((prev) => ({ ...prev, [sessionId]: derived.pendingInputs }));
      setPendingSteersBySession((prev) => ({ ...prev, [sessionId]: derived.pendingSteers }));
    } catch {
      // Clear the loaded flag so the caller can retry on next remount or tab
      // switch — otherwise a transient failure leaves the UI stuck with no
      // events. Without this clearSessionView, a failed initial load
      // permanently blocked re-entry until the chat received a new event.
      loadedHistoryRef.current.delete(sessionId);
    }
  }, [applyOlderHistoryCursor, clearSessionView, initialSessionSummary, lockSessionId]);

  /**
   * Resolves `true` once the backoff elapses, or `false` if the wait was
   * cancelled — a cancelled wait always resolves, so the caller's `finally`
   * still runs and the in-flight flag can never leak.
   */
  const waitBeforeOlderHistoryRetry = useCallback((delayMs: number) => (
    new Promise<boolean>((resolve) => {
      const waiter = { handle: 0, resolve };
      waiter.handle = window.setTimeout(() => {
        olderHistoryRetryWaitersRef.current.delete(waiter);
        resolve(true);
      }, delayMs);
      olderHistoryRetryWaitersRef.current.add(waiter);
    })
  ), []);

  const cancelOlderHistoryRetryWaits = useCallback(() => {
    for (const waiter of [...olderHistoryRetryWaitersRef.current]) {
      window.clearTimeout(waiter.handle);
      olderHistoryRetryWaitersRef.current.delete(waiter);
      waiter.resolve(false);
    }
  }, []);

  /**
   * Fetch the next OLDER transcript page for a session and prepend it to the
   * in-memory event list. Triggered by the message list when the user scrolls
   * near the top. One in-flight request per session; the cursor only moves
   * toward 0 (head), so retriggers are naturally deduped by cursor value.
   *
   * Paging failures retry silently on a bounded ladder before anything is
   * shown: a single blip on a remote hop should not make the user look at (and
   * press) a retry affordance for something we can just do ourselves.
   */
  const loadOlderHistory = useCallback(async (sessionId: string) => {
    const cursor = olderHistoryCursorRef.current[sessionId];
    if (cursor == null || cursor <= 0) return;
    if (olderHistoryInFlightRef.current.has(sessionId)) return;
    if (typeof window.ade.agentChat.getEventHistoryPage !== "function") return;
    olderHistoryInFlightRef.current.add(sessionId);
    setOlderHistoryLoadingBySession((prev) => ({ ...prev, [sessionId]: true }));
    setOlderHistoryErrorBySession((prev) => ({ ...prev, [sessionId]: null }));
    const runOlderHistoryPage = async (): Promise<void> => {
      let beforeOffset = cursor;
      let nextCursor = cursor;
      let olderEvents: AgentChatEventEnvelope[] = [];
      // A page spanning a single oversized JSONL line is empty but still
      // moves the cursor strictly toward the head — follow a bounded number
      // of those per trigger; the next scroll re-triggers if needed.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const page = await window.ade.agentChat.getEventHistoryPage({
          sessionId,
          beforeOffset,
          maxBytes: CHAT_HISTORY_PAGE_MAX_BYTES,
        });
        // `unavailable` is "we could not reach the runtime", NOT "this chat is
        // gone" — it arrives with `sessionFound: false` (preload synthesises
        // exactly that shape), so it MUST be caught first. Treating it as a
        // miss would zero the cursor and permanently unmount the "load older"
        // sentinel. Throwing routes it into the retry ladder below and leaves
        // the cursor untouched, which is what the ladder exists for.
        if (page?.unavailable === true) {
          throw new Error("Chat runtime is temporarily unavailable.");
        }
        if (page?.sessionId !== sessionId || page.sessionFound === false) {
          nextCursor = 0;
          break;
        }
        nextCursor = advanceOlderHistoryCursor(beforeOffset, page);
        if (page.events?.length) {
          olderEvents = page.events.filter((entry) => entry.sessionId === sessionId);
          break;
        }
        if (nextCursor <= 0) break;
        beforeOffset = nextCursor;
      }
      const maxEvents = sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
        ? MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS
        : MAX_BACKGROUND_CHAT_SESSION_EVENTS;
      const maxResidentBytes = sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
        ? MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES
        : MAX_BACKGROUND_CHAT_SESSION_RESIDENT_BYTES;
      if (olderEvents.length) {
        const existing = eventsBySessionRef.current[sessionId] ?? [];
        const { events: merged, hitResidentCap } = mergeOlderChatHistoryPageWithCap({
          older: olderEvents,
          existing,
          maxEvents,
          maxBytes: maxResidentBytes,
        });
        if (hitResidentCap) {
          detachedHistorySessionsRef.current.add(sessionId);
          delete detachedLiveEventsBySessionRef.current[sessionId];
        }
        if (merged !== existing) {
          eventsBySessionRef.current = { ...eventsBySessionRef.current, [sessionId]: merged };
          setEventsBySession((prev) => ({ ...prev, [sessionId]: merged }));
        }
        // `hitResidentCap` above may have just detached this view; the cache
        // write is skipped in that case (see writeAgentChatSessionViewCache).
        writeAgentChatSessionViewCache(
          sessionId,
          merged,
          undefined,
          nextCursor,
          maxEvents,
          detachedHistorySessionsRef.current.has(sessionId),
        );
      } else {
        writeAgentChatSessionViewCache(
          sessionId,
          eventsBySessionRef.current[sessionId] ?? [],
          undefined,
          nextCursor,
          maxEvents,
          detachedHistorySessionsRef.current.has(sessionId),
        );
      }
      applyOlderHistoryCursor(sessionId, nextCursor);
    };

    try {
      let lastError: unknown = null;
      for (let attempt = 0; attempt <= OLDER_HISTORY_RETRY_DELAYS_MS.length; attempt += 1) {
        if (attempt > 0) {
          const proceed = await waitBeforeOlderHistoryRetry(OLDER_HISTORY_RETRY_DELAYS_MS[attempt - 1] ?? 0);
          // Cancelled by a session switch or unmount — drop the ladder without
          // latching an error nobody is looking at any more.
          if (!proceed) return;
          // Something else already moved this session's cursor; retrying the
          // stale offset would fight it.
          if (olderHistoryCursorRef.current[sessionId] !== cursor) return;
        }
        try {
          await runOlderHistoryPage();
          return;
        } catch (error) {
          lastError = error;
        }
      }
      // Retries exhausted: latch a visible error. Keep the current cursor so a
      // later scroll can retry, and note that a latched error suppresses the
      // message list's automatic retriggers until the user asks again.
      setOlderHistoryErrorBySession((prev) => ({
        ...prev,
        [sessionId]: lastError instanceof Error && lastError.message.trim()
          ? lastError.message
          : "Couldn’t load earlier messages.",
      }));
    } finally {
      olderHistoryInFlightRef.current.delete(sessionId);
      setOlderHistoryLoadingBySession((prev) => ({ ...prev, [sessionId]: false }));
    }
  }, [applyOlderHistoryCursor, lockSessionId, waitBeforeOlderHistoryRetry]);

  const loadOlderHistoryForSelectedSession = useCallback(() => {
    const sessionId = selectedSessionIdRef.current;
    if (sessionId) void loadOlderHistory(sessionId);
  }, [loadOlderHistory]);

  // Cancel pending paging retries when the selection moves or the pane
  // unmounts, so no timer outlives the view that scheduled it.
  useEffect(() => () => cancelOlderHistoryRetryWaits(), [cancelOlderHistoryRetryWaits, selectedSessionId]);

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
    selectedSession?.reasoningEffort,
    selectedSession?.fastMode,
    selectedSession?.executionMode,
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
      // Only re-gate preferences when there is genuinely something to wait for:
      // a different project root, or a cold model catalog. Re-running this
      // effect for the same project (a remount, or a `refreshSessions` identity
      // change) used to blank `preferencesReady` and re-block the composer.
      const projectRootChanged = preferencesProjectRootRef.current !== projectRoot;
      preferencesProjectRootRef.current = projectRoot;
      if (projectRootChanged || !hasWarmChatModelCatalog(projectRoot)) {
        setPreferencesReady(false);
      }
      // Fire-and-forget: this snapshot only feeds `sendOnEnter`, so awaiting it
      // put a config round trip in front of the session list AND the model
      // catalog on every single boot.
      void getProjectConfigCached({ projectRoot })
        .then((snapshot) => {
          if (cancelled) return;
          // Don't auto-restore model — user must pick one explicitly each session
          setSendOnEnter(snapshot.effective.ai?.chat?.sendOnEnter ?? true);
        })
        .catch(() => {
          // fall back to defaults.
        });

      const sessionsRefresh = refreshSessions().catch(() => undefined);
      const modelsRefresh = refreshAvailableModels().catch(() => []);
      // The readiness gate is the FIRST refresh for this project root; later
      // mounts still run their own refresh for state, but wait on the settled
      // one so they are ready in a microtask.
      const modelsReadinessGate = rememberChatBootModelRefresh(projectRoot, modelsRefresh);
      try {
        await sessionsRefresh;
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
      try {
        await modelsReadinessGate;
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
  }, [initialSessionSummary, lockSessionId, projectRoot, refreshAvailableModels, refreshSessions]);

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
    setReasoningEffort(selectReasoningEffort({ tiers: reasoningTiers, preferred, modelId }));
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

      openTerminalPanel();
      if (!hasExternalTerminalPane) {
        setTerminalRevealRequest({
          terminalId: session.id,
          ptyId,
          label: session.title?.trim() || "Terminal",
          nonce: ++terminalRevealNonceRef.current,
        });
      }
    };

    const unsubscribe = sessionsApi.onChanged((event) => {
      if (event.reason !== "created") return;
      void revealCreatedTerminal(event.sessionId);
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [chatTerminalVisible, hasExternalTerminalPane, laneId, openTerminalPanel]);

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
    const previous = knownSessionIdsRef.current;
    knownSessionIdsRef.current = next;
    // The view cache is module-level and outlives every pane, so a chat that
    // leaves this pane's roster (deleted, archived, or its project/lane closed)
    // would otherwise keep a whole transcript resident until eight newer chats
    // pushed it out. Release its retention subscription too.
    const departed = selectDepartedChatSessionViewCacheSessions(
      previous,
      next,
      [selectedSessionId, lockSessionId, initialSessionId],
    );
    if (!departed.length) return;
    for (const sessionId of departed) releaseRetainedChatSession(sessionId);
    clearAgentChatSessionViewCacheForSessions(departed);
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
      setHandoffFastMode(fastMode);
      setHandoffClaudePermissionMode(claudePermissionMode);
      setHandoffCodexApprovalPolicy(codexApprovalPolicy);
      setHandoffCodexSandbox(codexSandbox);
      setHandoffCodexConfigSource(codexConfigSource);
      setHandoffOpenCodePermissionMode(opencodePermissionMode);
      setHandoffDroidPermissionMode(droidPermissionMode);
      setHandoffCursorModeId(cursorModeId);
      setHandoffCursorConfigValues({ ...cursorConfigValues });
      setHandoffNote("");
      // Land on the menu each open; default the local mode to fork when the
      // source provider can fork, else brief. Seed lane + remote model.
      setHandoffView("menu");
      setHandoffLocalMode(providerSupportsHandoffFork(selectedSession?.provider) ? "fork" : "brief");
      setHandoffTargetLaneId(selectedSession?.laneId ?? laneId ?? "");
      setRemoteHandoffModelId(
        selectedSessionModelId
          || handoffAvailableModelIds[0]
          || "",
      );
    }
    prevHandoffOpenRef.current = chatActionsHandoffActive;
    // Intentional: one-shot on open; avoid resetting the handoff form when underlying composer state changes while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatActionsHandoffActive]);

  // The one-shot open effect above can run before the model catalog loads,
  // seeding the remote model to "". Backfill it when models arrive so the
  // cross-machine modal never prepares with an empty targetModelId.
  useEffect(() => {
    if (!chatActionsHandoffActive || handoffAvailableModelIds.length === 0) return;
    setRemoteHandoffModelId((current) => {
      if (current && handoffAvailableModelIds.includes(current)) return current;
      if (selectedSessionModelId && handoffAvailableModelIds.includes(selectedSessionModelId)) {
        return selectedSessionModelId;
      }
      return handoffAvailableModelIds[0] ?? current;
    });
  }, [chatActionsHandoffActive, handoffAvailableModelIds, selectedSessionModelId]);

  // Keep the fork model picker on a same-provider model. When the local view is
  // in fork mode, snap handoffModelId into the constrained list (preferring the
  // source model) so the picker value never falls outside the fork catalog.
  useEffect(() => {
    if (!chatActionsHandoffActive) return;
    if (handoffView !== "local" || handoffLocalMode !== "fork" || !handoffForkSupported) return;
    if (handoffForkAvailableModelIds.length === 0) return;
    setHandoffModelId((current) => {
      if (current && handoffForkAvailableModelIds.includes(current)) return current;
      if (selectedSessionModelId && handoffForkAvailableModelIds.includes(selectedSessionModelId)) {
        return selectedSessionModelId;
      }
      return handoffForkAvailableModelIds[0] ?? current;
    });
  }, [
    chatActionsHandoffActive,
    handoffForkAvailableModelIds,
    handoffForkSupported,
    handoffLocalMode,
    handoffView,
    selectedSessionModelId,
  ]);

  useEffect(() => {
    if (!chatActionsHandoffActive || !handoffModelId) return;
    setHandoffReasoningEffort((prev) => clampHandoffReasoningToModel(prev, handoffTargetDescriptor));
  }, [chatActionsHandoffActive, handoffModelId, handoffTargetDescriptor]);

  useEffect(() => {
    if (!isTileVisible) return;
    if (!selectedSessionId) return;
    // Take the stream back from the retention module (see chatSessionRetention).
    // `adopted` means the cached view already carries everything that arrived
    // while this pane was hidden, so the reconcile below is gap insurance
    // against the remote pump's epoch resets / `replay:false` rebinds rather
    // than the primary catch-up — fire it immediately and only once.
    const adopted = adoptRetainedSession(selectedSessionId);
    const restoredFromCache = applyCachedSessionView(selectedSessionId);
    const refreshOptions = { force: !restoredFromCache };
    // `mergeChatHistorySnapshot` dedupes, so this can never blank the view.
    const reconcileDelayMs = adopted ? 0 : 650;
    if (!lockedSingleSessionMode) {
      // Re-read the selected transcript on every tab switch so the selected
      // chat can recover from any background event loss instead of relying
      // solely on the in-memory background buffer.
      void loadHistory(selectedSessionId, refreshOptions);
      if (!restoredFromCache) return;
      const refreshHandle = window.setTimeout(() => {
        void loadHistory(selectedSessionId, { force: true });
      }, reconcileDelayMs);
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
      }, Math.max(reconcileDelayMs, hydrateDelayMs + reconcileDelayMs));
    }
    return () => {
      window.clearTimeout(handle);
      if (refreshHandle != null) window.clearTimeout(refreshHandle);
    };
  }, [applyCachedSessionView, isTileActive, isTileVisible, loadHistory, lockedSingleSessionMode, selectedSessionId]);

  // Subscription handoff. While this pane is visible it owns the only
  // `agentChat.onEvent` subscription; when it hides or unmounts the retention
  // module opens its own so the remote event pump keeps polling and the
  // transcript is current on return instead of stale by a whole tab visit.
  // Deps are deliberately minimal — anything else would retain/release on
  // unrelated re-renders.
  useEffect(() => {
    if (!isTileVisible || !selectedSessionId) return undefined;
    return () => {
      retainChatSession(selectedSessionId);
    };
  }, [isTileVisible, selectedSessionId]);

  useEffect(() => {
    if (!isTileVisible || !selectedSessionId) return undefined;
    const shouldRecoverLiveTranscript =
      turnActive
      || selectedSession?.status === "active"
      || selectedSessionAwaitingInput;
    if (!shouldRecoverLiveTranscript && selectedEvents.length > 0) return undefined;

    let disposed = false;
    const recover = (options?: { skipWhenLive?: boolean }) => {
      if (disposed) return;
      // A live subscription plus retention already delivers the transcript, so
      // re-reading it while events are flowing is pure cost.
      if (
        options?.skipWhenLive
        && lastEventReceivedAtMsRef.current > 0
        && Date.now() - lastEventReceivedAtMsRef.current < ACTIVE_TURN_RECOVERY_INTERVAL_MS
      ) return;
      void loadHistory(selectedSessionId, { force: true });
    };

    // A newly-created headless chat can become visible before its first
    // transcript append or lifecycle event reaches the renderer. An active
    // session uses the normal live polling loop; an empty idle session gets
    // two bounded retries so a stale summary cannot strand a blank pane.
    if (!shouldRecoverLiveTranscript) {
      const retryTimers = [900, 3_000].map((delayMs) => window.setTimeout(() => recover(), delayMs));
      return () => {
        disposed = true;
        retryTimers.forEach((timer) => window.clearTimeout(timer));
      };
    }

    const offset = stableSessionDelayOffset(selectedSessionId);
    const initialDelayMs = isTileActive ? 900 : 1200 + (offset % 500);
    // Jittered so a grid of tiles doesn't re-read every transcript on the same
    // frame; the base is the stall-detector interval, not a polling rate.
    const intervalMs = ACTIVE_TURN_RECOVERY_INTERVAL_MS + (isTileActive ? 0 : offset % 1_500);
    const tick = () => recover({ skipWhenLive: true });
    const initialTimer = window.setTimeout(tick, initialDelayMs);
    const intervalTimer = window.setInterval(tick, intervalMs);
    return () => {
      disposed = true;
      window.clearTimeout(initialTimer);
      window.clearInterval(intervalTimer);
    };
  }, [
    isTileActive,
    isTileVisible,
    loadHistory,
    selectedEvents.length,
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
    setChatActionsOpen(false);
    setHandoffBusy(false);
    setModelPickerOpenRequest(undefined);
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
        sameSession
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
    const derivationEventsBySession = new Map<string, AgentChatEventEnvelope[]>();
    const queuedBySession = new Map<string, AgentChatEventEnvelope[]>();

    for (const envelope of queued) {
      const sessionId = envelope.sessionId;
      const sessionQueue = queuedBySession.get(sessionId);
      if (sessionQueue) sessionQueue.push(envelope);
      else queuedBySession.set(sessionId, [envelope]);
    }

    for (const [sessionId, sessionQueue] of queuedBySession) {
      const sessionEvents = eventsBySessionRef.current[sessionId] ?? [];
      const sessionEventKeys = new Set(sessionEvents.map(chatEventDedupKey));
      const freshEvents: AgentChatEventEnvelope[] = [];
      for (const envelope of sessionQueue) {
        const envelopeKey = chatEventDedupKey(envelope);
        if (sessionEventKeys.has(envelopeKey)) continue;
        sessionEventKeys.add(envelopeKey);
        freshEvents.push(envelope);
      }
      if (!freshEvents.length) continue;
      if (detachedHistorySessionsRef.current.has(sessionId)) {
        const liveEvents = trimChatEventHistory(
          [...(detachedLiveEventsBySessionRef.current[sessionId] ?? []), ...freshEvents],
          MAX_BACKGROUND_CHAT_SESSION_EVENTS,
          MAX_BACKGROUND_CHAT_SESSION_RESIDENT_BYTES,
        );
        detachedLiveEventsBySessionRef.current = {
          ...detachedLiveEventsBySessionRef.current,
          [sessionId]: liveEvents,
        };
        derivationEventsBySession.set(sessionId, liveEvents);
        touchedSessionIds.add(sessionId);
        continue;
      }
      const updated = trimChatEventHistory(
        [...sessionEvents, ...freshEvents],
        sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
          ? MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS
          : MAX_BACKGROUND_CHAT_SESSION_EVENTS,
        sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
          ? MAX_SELECTED_CHAT_SESSION_RESIDENT_BYTES
          : MAX_BACKGROUND_CHAT_SESSION_RESIDENT_BYTES,
      );
      if (next === eventsBySessionRef.current) next = { ...eventsBySessionRef.current };
      next[sessionId] = updated;
      derivationEventsBySession.set(sessionId, updated);
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
      const derivationEvents = derivationEventsBySession.get(sessionId) ?? next[sessionId] ?? [];
      const derived = deriveRuntimeState(derivationEvents);
      const sessionSummary = sessionsRef.current.find((entry) => entry.sessionId === sessionId)
        ?? (initialSessionSummary?.sessionId === sessionId ? initialSessionSummary : null);
      const maxEvents = sessionId === selectedSessionIdRef.current || sessionId === lockSessionId
        ? MAX_SELECTED_CHAT_SESSION_RESIDENT_EVENTS
        : MAX_BACKGROUND_CHAT_SESSION_EVENTS;
      if (!detachedHistorySessionsRef.current.has(sessionId)) {
        writeAgentChatSessionViewCache(
          sessionId,
          next[sessionId] ?? [],
          derived,
          olderHistoryCursorRef.current[sessionId] ?? null,
          maxEvents,
        );
      }
      activePatch[sessionId] = resolveTurnActive(derivationEvents, derived.turnActive, sessionSummary);
      pendingInputPatch[sessionId] = derived.pendingInputs;
      pendingSteerPatch[sessionId] = derived.pendingSteers;
    }

    // All setters fire synchronously — React 18 batches them into one render.
    setEventsBySession(next);
    setTurnActiveBySession((activePrev) => ({ ...activePrev, ...activePatch }));
    setPendingInputsBySession((pendingPrev) => ({ ...pendingPrev, ...pendingInputPatch }));
    setPendingSteersBySession((steerPrev) => ({ ...steerPrev, ...pendingSteerPatch }));
  }, [initialSessionSummary, lockSessionId]);

  const returnSelectedHistoryToLatest = useCallback(() => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId || !detachedHistorySessionsRef.current.has(sessionId)) return;
    // Keep buffering live events until the authoritative tail snapshot lands.
    // loadHistory clears detached state only after a successful hydrate, so a
    // transient remote failure leaves the historical window retryable.
    void loadHistory(sessionId, { force: true });
  }, [loadHistory]);

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
      // Liveness stamp for the active-turn stall detector — recorded before any
      // filtering so an event for a sibling chat still proves the stream is up.
      lastEventReceivedAtMsRef.current = Date.now();
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
        if (meta.historyInvalidated === true && envelope.sessionId === selectedSessionIdRef.current) {
          void loadHistory(envelope.sessionId, { force: true });
        }
        const summaryPatch: Partial<AgentChatSessionSummary> = {};
        if (typeof meta.title === "string" && meta.title.length > 0) summaryPatch.title = meta.title;
        if (meta.claudeTag !== undefined) summaryPatch.claudeTag = meta.claudeTag;
        if (meta.permissionMode !== undefined) summaryPatch.permissionMode = meta.permissionMode;
        if (meta.interactionMode !== undefined) summaryPatch.interactionMode = meta.interactionMode;
        if (meta.claudePermissionMode !== undefined) summaryPatch.claudePermissionMode = meta.claudePermissionMode;
        if (meta.codexApprovalPolicy !== undefined) summaryPatch.codexApprovalPolicy = meta.codexApprovalPolicy;
        if (meta.codexSandbox !== undefined) summaryPatch.codexSandbox = meta.codexSandbox;
        if (meta.codexConfigSource !== undefined) summaryPatch.codexConfigSource = meta.codexConfigSource;
        if (meta.opencodePermissionMode !== undefined) summaryPatch.opencodePermissionMode = meta.opencodePermissionMode;
        if (meta.droidPermissionMode !== undefined) summaryPatch.droidPermissionMode = meta.droidPermissionMode;
        if (meta.cursorModeId !== undefined) summaryPatch.cursorModeId = meta.cursorModeId;
        if (meta.cursorModeSnapshot !== undefined) summaryPatch.cursorModeSnapshot = meta.cursorModeSnapshot;
        if (meta.cursorConfigValues !== undefined) summaryPatch.cursorConfigValues = meta.cursorConfigValues;
        if (Object.keys(summaryPatch).length > 0) {
          patchSessionSummary(envelope.sessionId, summaryPatch);
        }
        // The composer seeds its local mode state from the session scope, not
        // summary content, so a summary patch alone won't re-seed the selected
        // chat. Apply the authoritative mode fields directly to composer state
        // (mirrors the plan-mode transition special-case below). summaryPatch's
        // keys are exactly `title` plus the mode fields (each gated on the same
        // `meta.X !== undefined` check), so any non-title key means a mode changed.
        const modeChanged = Object.keys(summaryPatch).some((key) => key !== "title");
        if (modeChanged && envelope.sessionId === selectedSessionIdRef.current) {
          if (meta.interactionMode !== undefined) {
            setInteractionMode(meta.interactionMode ?? initialNativeControls.interactionMode);
          }
          if (meta.claudePermissionMode !== undefined) setClaudePermissionMode(meta.claudePermissionMode);
          if (meta.codexApprovalPolicy !== undefined) setCodexApprovalPolicy(meta.codexApprovalPolicy);
          if (meta.codexSandbox !== undefined) setCodexSandbox(meta.codexSandbox);
          if (meta.codexConfigSource !== undefined) setCodexConfigSource(meta.codexConfigSource);
          if (meta.opencodePermissionMode !== undefined) setOpenCodePermissionMode(meta.opencodePermissionMode);
          if (meta.droidPermissionMode !== undefined) setDroidPermissionMode(meta.droidPermissionMode);
          if (
            meta.cursorModeId !== undefined
            || meta.cursorModeSnapshot !== undefined
            || meta.cursorConfigValues !== undefined
          ) {
            const snapshot = meta.cursorModeSnapshot;
            if ("cursorModeId" in meta) {
              // The event carries an explicit cursorModeId — including a `null`
              // clear, which must reach the composer rather than `??`-falling
              // back to a stale mode/snapshot. summaryPatch above already stored
              // the same cleared value, so the two stay in agreement.
              setCursorModeId(meta.cursorModeId ?? null);
            } else if (snapshot !== undefined) {
              // Key absent but a snapshot arrived: derive the current mode from
              // it. A partial event with neither field leaves the mode unchanged.
              setCursorModeId(snapshot.currentModeId ?? initialNativeControls.cursorModeId);
            }
            // An explicit cursorConfigValues in the event is authoritative (it
            // carries config-only changes the snapshot may not reflect, since
            // the host only recomputes cursorModeSnapshot on mode changes);
            // otherwise fall back to deriving values from the snapshot.
            if (meta.cursorConfigValues !== undefined) {
              setCursorConfigValues(meta.cursorConfigValues ?? {});
            } else if (snapshot) {
              setCursorConfigValues(
                Object.fromEntries(
                  (snapshot.configOptions ?? [])
                    .filter((option) => option.id !== snapshot.modeConfigId)
                    .flatMap((option) => option.currentValue == null ? [] : [[option.id, option.currentValue]]),
                ),
              );
            }
          }
        }
        return;
      }

      // Keep prompt suggestions keyed by session so suggestions never leak
      // across chat tabs before the composer renders the new selection. These
      // are composer UI hints, not transcript content.
      if (envelope.event.type === "prompt_suggestion" && "suggestion" in envelope.event) {
        const suggestion = typeof (envelope.event as any).suggestion === "string"
          ? (envelope.event as any).suggestion.trim()
          : "";
        setPromptSuggestionsBySession((prev) => (
          suggestion.length > 0
            ? { ...prev, [envelope.sessionId]: suggestion }
            : (() => {
                if (!(envelope.sessionId in prev)) return prev;
                const next = { ...prev };
                delete next[envelope.sessionId];
                return next;
              })()
        ));
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

      // Clear prompt suggestion when a new turn starts
      if (envelope.event.type === "status" && envelope.event.turnStatus === "started") {
        clearPromptSuggestionForSession(envelope.sessionId);
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
  }, [clearPromptSuggestionForSession, isRemoteProject, isTileVisible, layoutVariant, loadHistory, lockSessionId, flushQueuedEvents, patchSessionSummary, scheduleQueuedEventFlush, scheduleSessionsRefresh, touchSession]);

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
    window.addEventListener("ade:agent-chat:add-plan-annotation", onAddPlanAnnotation);
    return () => {
      window.removeEventListener("ade:agent-chat:add-attachment", onAddAttachment);
      window.removeEventListener("ade:agent-chat:insert-draft", onInsertDraft);
      window.removeEventListener("ade:agent-chat:add-ios-context", onAddIosContext);
      window.removeEventListener("ade:agent-chat:add-app-control-context", onAddAppControlContext);
      window.removeEventListener("ade:agent-chat:add-builtin-browser-context", onAddBuiltInBrowserContext);
      window.removeEventListener("ade:agent-chat:add-plan-annotation", onAddPlanAnnotation);
    };
  }, [
    addAppControlContext,
    addAttachment,
    addBuiltInBrowserContext,
    addIosElementContext,
    draftContextTargetId,
    forceDraft,
    insertComposerDraft,
  ]);

  // Resend the most recent user message after a recoverable provider failure.
  // A forced provider refresh clears stale auth/capacity health before the new
  // turn starts in the same durable thread.
  const rejectAuthRetry = useCallback((sessionId: string) => {
    window.dispatchEvent(new CustomEvent(CHAT_AUTH_RETRY_REJECTED_EVENT, { detail: { sessionId } }));
  }, []);

  const resendLastUserMessage = useCallback(async (sessionId: string, failedTurnId?: string | null) => {
    if (submitInFlightRef.current) {
      rejectAuthRetry(sessionId);
      return "Another message is already being sent. Wait for it to finish before retrying.";
    }
    const events = selectedEventsForDisplayRef.current;
    let userEvent = failedTurnId ? findUserMessageForTurn(events, failedTurnId) : null;
    if (!failedTurnId) {
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const evt = events[index]?.event;
        if (
          evt != null
          && isParentUserMessage(evt)
          && typeof evt.text === "string"
          && evt.text.trim().length > 0
        ) {
          userEvent = evt;
          break;
        }
      }
    }
    if (!userEvent) {
      rejectAuthRetry(sessionId);
      return "ADE could not find the original message for this failed turn.";
    }
    const text = userEvent.text;
    const displayText = typeof userEvent.displayText === "string" ? userEvent.displayText : text;
    const attachments = Array.isArray(userEvent.attachments) ? userEvent.attachments : [];
    const contextAttachments = Array.isArray(userEvent.contextAttachments) ? userEvent.contextAttachments : [];
    const metadata = userEvent.metadata;
    const replayContext = {
      ...(attachments.length ? { attachments } : {}),
      ...(contextAttachments.length ? { contextAttachments } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    };
    try {
      submitInFlightRef.current = true;
      setBusy(true);
      setError(null);
      touchSession(sessionId);
      await refreshAvailableModels({ force: true });
      try {
        await window.ade.agentChat.send({ sessionId, text, displayText, ...replayContext });
      } catch (sendError) {
        if (!isTurnAlreadyActiveError(sendError)) throw sendError;
        rejectAuthRetry(sessionId);
        return "A turn is already active in this thread. Wait for it to finish before retrying.";
      }
      void refreshSessions().catch(() => {});
      return null;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      return message;
    } finally {
      submitInFlightRef.current = false;
      setBusy(false);
    }
  }, [refreshAvailableModels, refreshSessions, rejectAuthRetry, touchSession]);

  // Mosaic card submit → structured reply through the normal chat send path.
  const handleMosaicSubmit = useCallback(async (submission: { text: string; displayText: string }) => {
    const sessionId = selectedSessionIdRef.current;
    if (!sessionId) return;
    try {
      setError(null);
      touchSession(sessionId);
      await window.ade.agentChat.send({ sessionId, text: submission.text, displayText: submission.displayText });
      void refreshSessions().catch(() => {});
    } catch (mosaicSendError) {
      setError(mosaicSendError instanceof Error ? mosaicSendError.message : String(mosaicSendError));
      throw mosaicSendError;
    }
  }, [refreshSessions, touchSession]);

  const mosaicCardKeyFor = useCallback(
    // Scope (the transcript row key) keeps byte-identical cards at different
    // positions independently answerable.
    (source: string, scope: string) => `${selectedSessionIdRef.current ?? "draft"}:${scope}:${djb2Hash(source)}`,
    [],
  );

  // Interactive mosaic cards are Claude-family only; other runtimes fall back to
  // the plain code fence. Memoized so AgentChatMessageList's row memo holds.
  const mosaicContext = useMemo<MosaicRenderContext | undefined>(() => {
    if (sessionProvider !== "claude") return undefined;
    // Pass the promise through — the card awaits it and rolls back its
    // answered latch when the send rejects.
    return { cardKeyFor: mosaicCardKeyFor, onSubmit: handleMosaicSubmit };
  }, [sessionProvider, mosaicCardKeyFor, handleMosaicSubmit]);

  // The inline re-login card dispatches CHAT_RETRY_AUTH_TURN_EVENT on "Retry
  // turn"; only the pane that owns the session resends.
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: string | null }>).detail;
      const sessionId = detail?.sessionId;
      if (typeof sessionId !== "string" || sessionId !== selectedSessionIdRef.current) return;
      void resendLastUserMessage(sessionId);
    };
    window.addEventListener(CHAT_RETRY_AUTH_TURN_EVENT, handler);
    return () => window.removeEventListener(CHAT_RETRY_AUTH_TURN_EVENT, handler);
  }, [resendLastUserMessage]);

  // When a turn succeeds after a logout, tell visible re-login cards for this
  // session to collapse into a quiet "Reconnected" confirmation.
  useEffect(() => {
    const sessionId = selectedSessionId;
    if (!sessionId) return;
    const events = selectedEventsForDisplay;
    let lastAuthErrorIndex = -1;
    let lastAuthErrorKey: string | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const envelope = events[index];
      const evt = events[index]?.event;
      if (
        evt?.type === "error"
        && typeof evt.errorInfo === "object"
        && evt.errorInfo?.agentCli?.category === "unauthenticated"
      ) {
        lastAuthErrorIndex = index;
        const turnId = typeof evt.turnId === "string" && evt.turnId.trim().length ? evt.turnId.trim() : null;
        const itemId = typeof evt.itemId === "string" && evt.itemId.trim().length ? evt.itemId.trim() : null;
        lastAuthErrorKey = `${sessionId}:${turnId ?? itemId ?? envelope?.timestamp ?? evt.message}`;
        break;
      }
    }
    if (lastAuthErrorIndex === -1) return;
    let recovered = false;
    for (let index = lastAuthErrorIndex + 1; index < events.length; index += 1) {
      const evt = events[index]?.event;
      if (!evt) continue;
      if (evt.type === "done" && evt.status === "completed") { recovered = true; break; }
      if (evt.type === "text" && typeof evt.text === "string" && evt.text.trim().length > 0) { recovered = true; break; }
      if (evt.type === "tool_call") { recovered = true; break; }
    }
    if (!recovered) return;
    const key = lastAuthErrorKey ?? `${sessionId}:auth-error`;
    if (dispatchedAuthRecoveryRef.current.has(key)) return;
    const recoveryDispatchTimer = window.setTimeout(() => {
      dispatchedAuthRecoveryRef.current.add(key);
      window.dispatchEvent(new CustomEvent(CHAT_AUTH_RECOVERED_EVENT, { detail: { sessionId } }));
    }, 0);
    return () => window.clearTimeout(recoveryDispatchTimer);
  }, [selectedEventsForDisplay, selectedSessionId]);

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
    composerDraftHydratingTextRef.current = saved?.text ?? null;
    if (saved) {
      for (const storageKey of composerDraftStorageKeyValues) {
        writeComposerDraftSnapshot(storageKey, saved);
      }
      draftsPerSessionRef.current.set(companionStateKey, saved.text);
      setDraft(saved.text);
      setAttachments(saved.attachments);
      setContextAttachments(saved.contextAttachments);
      setIosElementContextItems(saved.iosContextItems);
      setAppControlContextItems(saved.appControlContextItems);
      setBuiltInBrowserContextItems(saved.builtInBrowserContextItems);
      setDraftLaunchTargetId(saved.draftLaunchTargetId);
      if (!selectedSessionId && saved.modelId) {
        draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
        draftLaunchConfigHydratedRef.current = `${draftLaunchConfigScopeKey}:composer-draft`;
        applyLaunchConfigToComposer({
          version: 1,
          modelId: saved.modelId,
          reasoningEffort: saved.reasoningEffort,
          fastMode: saved.fastMode,
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
      const hydratedText = composerDraftHydratingTextRef.current;
      composerDraftHydratingTextRef.current = null;
      if (draft === hydratedText) return;
    }
    draftsPerSessionRef.current.set(companionStateKey, draft);
    const snapshot: ComposerDraftStorageSnapshot = {
      version: 1,
      text: draft,
      modelId,
      reasoningEffort,
      fastMode,
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
    fastMode,
    companionStateKey,
    composerDraftStorageKeyValue,
    contextAttachments,
    currentNativeControls,
    draft,
    draftLaunchTargetId,
    executionMode,
    iosElementContextItems,
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
        fastMode,
        executionMode,
      }),
      cloneParallelSlotFromComposer({
        native: currentNativeControls,
        modelId,
        reasoningEffort,
        fastMode,
        executionMode,
      }),
    ]);
  }, [parallelChatMode, parallelModelSlots.length, currentNativeControls, modelId, reasoningEffort, fastMode, executionMode]);

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
    const nextReasoningEffort = selectReasoningEffort({ tiers, preferred, modelId: nextModelId });
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

  const canRefreshPinnedProject = useCallback((pin?: OpenProjectBinding | null) => (
    !pin || rootAppStoreApi.getState().projectBinding?.key === pin.key
  ), []);

  const createSessionForLane = useCallback(async (
    targetLaneId: string,
    options: {
      select?: boolean;
      notify?: boolean;
      notifyOptions?: AgentChatSessionCreatedOptions;
      launchState?: DraftLaunchSnapshot;
      // Draft launches pass a guard that throws if the originating project
      // changed (or the launch timed out); checked before the inner
      // orchestration mutation so a bundle is never allocated in the wrong project.
      assertActive?: () => void;
      // Originating project binding, used to pin the orchestrator lead rollback.
      pin?: OpenProjectBinding | null;
    } = {},
  ): Promise<AgentChatSession> => {
      if (constrainedModelSelectionError) {
        throw new Error(constrainedModelSelectionError);
      }
      const launchModelId = options.launchState?.modelId ?? modelId;
      const launchReasoningEffort = options.launchState?.reasoningEffort ?? reasoningEffort;
      const launchFastMode = options.launchState?.fastMode ?? fastMode;
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
        orchestratorEnabled
          ? { interactionMode: "orchestrator-lead" as AgentChatInteractionMode }
          : {};
      const createArgs = {
        laneId: targetLaneId,
        provider,
        model,
        modelId: launchModelId,
        sessionProfile,
        reasoningEffort: launchReasoningEffort,
        ...(modelSupportsFastMode(desc) ? { fastMode: launchFastMode } : {}),
        ...nativeControlPayload,
        ...orchestratorOverrides,
      };
      const created = options.pin
        ? await window.ade.agentChat.create(createArgs, options.pin)
        : await window.ade.agentChat.create(createArgs);
      invalidateAgentChatSessionListCache({ laneId: targetLaneId });
      // Follow-up: allocate the orchestration bundle. We do this immediately
      // so the bundle path is persisted alongside the new chat (workers will
      // pick it up from the manifest). If it fails, stop before sending the
      // first prompt so a half-created lead chat cannot start working.
      if (orchestratorEnabled) {
        try {
          options.assertActive?.();
          const runCreateArgs = {
            laneId: targetLaneId,
            leadSessionId: created.id,
          };
          const runCreate = options.pin
            ? await window.ade.orchestration.runCreate(runCreateArgs, options.pin)
            : await window.ade.orchestration.runCreate(runCreateArgs);
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
          await window.ade.agentChat.delete({ sessionId: created.id }, options.pin).catch((cleanupError: unknown) => {
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
        fastMode: modelSupportsFastMode(desc) && launchFastMode,
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
          if (targetLaneId === laneId && canRefreshPinnedProject(options.pin)) void refreshSessions({ force: true });
        }).catch(() => { /* warmup is best-effort */ });
      }
      if (options.notify) notifySessionCreated(created, options.notifyOptions);
      if (targetLaneId === laneId && canRefreshPinnedProject(options.pin)) void refreshSessions({ force: true }).catch(() => {});
      return created;
  }, [canRefreshPinnedProject, fastMode, constrainedModelSelectionError, currentNativeControls, executionMode, initialNativeControls, laneId, lastLaunchConfigStorageKey, modelId, notifySessionCreated, orchestratorEnabled, patchSessionSummary, reasoningEffort, refreshSessions, touchSession, workDraftKind]);

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
    const contextAttachmentsSnapshot = [...contextAttachments];
    const visualContextPrefix = [
      formatIosElementContextForPrompt(iosContextSnapshot),
      formatAppControlContextForPrompt(appControlContextSnapshot),
      formatBuiltInBrowserContextForPrompt(builtInBrowserContextSnapshot),
    ].filter(Boolean).join("\n");
    const visualContextDisplayChips = [
      formatIosElementContextChipsForDisplay(iosContextSnapshot),
      formatAppControlContextChipsForDisplay(appControlContextSnapshot),
      formatBuiltInBrowserContextChipsForDisplay(builtInBrowserContextSnapshot),
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
      fastMode,
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
      visualContextPrefix,
      visualContextDisplayChips,
      isLiteralSlashCommand: isProviderSlashCommandInput(text),
    };
  }, [
    appControlContextItems,
    attachments,
    builtInBrowserContextItems,
    fastMode,
    contextAttachments,
    currentNativeControls,
    draft,
    executionMode,
    interactionMode,
    iosElementContextItems,
    isWorkCliLaunchDraft,
    modelId,
    reasoningEffort,
  ]);

  const prepareDraftLaunchForSend = useCallback(async (
    snapshot: DraftLaunchSnapshot,
    _targetLaneId: string,
  ): Promise<PreparedDraftLaunch> => {
    const finalTextPrefix = snapshot.visualContextPrefix;
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
    if (snapshot.modelId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
      draftLaunchConfigHydratedRef.current = `${draftLaunchConfigScopeKey}:restored-launch`;
      applyLaunchConfigToComposer({
        version: 1,
        modelId: snapshot.modelId,
        reasoningEffort: snapshot.reasoningEffort,
        fastMode: snapshot.fastMode,
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
    // Read from the ROOT store, matching where setDraftLaunchJobs writes.
    return (rootAppStoreApi.getState().draftLaunchJobsByScope[draftLaunchJobsScopeKey] ?? EMPTY_DRAFT_LAUNCH_JOBS)
      .some((job) => job.id === jobId);
  }, [draftLaunchJobsScopeKey]);

  const dismissDraftLaunchJob = useCallback((jobId: string) => {
    setDraftLaunchJobs((current) => current.filter((job) => job.id !== jobId));
  }, [setDraftLaunchJobs]);

  const restoreDraftLaunchJob = useCallback((job: DraftLaunchJob, options?: { clearError?: boolean }) => {
    restoreDraftLaunchSnapshot(job.snapshot);
    dismissDraftLaunchJob(job.id);
    if (options?.clearError) setError(null);
  }, [dismissDraftLaunchJob, restoreDraftLaunchSnapshot]);

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

  // Robust foreground auto-open: a foreground send (Enter) opens the chat
  // directly with no status banner. If the inline open was skipped because this
  // pane remounted mid-launch, this effect opens the ready job from whichever
  // instance is mounted.
  useEffect(() => {
    if (!forceDraft) return;
    const job = draftLaunchJobs.find(
      (entry) => entry.mode === "foreground"
        && entry.status === "ready"
        && entry.autoOpen
        && Boolean(entry.laneId && entry.laneName && entry.sessionId),
    );
    if (!job) return;
    openLaunchedDraftSession({
      laneId: job.laneId!,
      laneName: job.laneName!,
      sessionId: job.sessionId!,
      draftKind: job.draftKind,
      jobId: job.id,
    });
  }, [draftLaunchJobs, forceDraft, openLaunchedDraftSession]);

  // Shared background-naming lifecycle: flag the affected lanes as "naming", ask
  // the backend for a name (it has its own timeout and returns the deterministic
  // fallback on failure, so a no-op result is skipped), apply it via `apply`, then
  // always clear the flags. Naming never sits on the critical path — lanes are
  // created instantly with deterministic names and upgraded here in the background.
  const runBackgroundLaneNaming = useCallback((args: {
    laneId: string;
    prompt: string;
    modelId: string;
    fallbackName: string;
    flagLaneIds: string[];
    pin?: OpenProjectBinding | null;
    apply: (suggested: string) => Promise<void>;
  }) => {
    if (!args.flagLaneIds.length) return;
    for (const id of args.flagLaneIds) setLaneNaming(id, true);
    void (async () => {
      const suggestArgs = {
        laneId: args.laneId,
        prompt: args.prompt,
        modelId: args.modelId,
        fallbackName: args.fallbackName,
      };
      const suggestLaneName = () => (args.pin
        ? window.ade.agentChat.suggestLaneName(suggestArgs, args.pin)
        : window.ade.agentChat.suggestLaneName(suggestArgs));
      const sleep = (ms: number) => new Promise<void>((resolve) => {
        window.setTimeout(resolve, ms);
      });
      const BACKGROUND_LANE_NAMING_ATTEMPTS = 2;
      const BACKGROUND_LANE_NAMING_RETRY_DELAY_MS = 750;
      try {
        let suggested = "";
        for (let attempt = 1; attempt <= BACKGROUND_LANE_NAMING_ATTEMPTS; attempt += 1) {
          try {
            suggested = (await suggestLaneName()).trim();
          } catch (error) {
            if (attempt >= BACKGROUND_LANE_NAMING_ATTEMPTS) {
              throw error;
            }
            console.warn(`background lane naming attempt ${attempt} failed; retrying`, error);
            await sleep(BACKGROUND_LANE_NAMING_RETRY_DELAY_MS);
            continue;
          }
          if (suggested && suggested !== args.fallbackName) {
            break;
          }
          if (attempt < BACKGROUND_LANE_NAMING_ATTEMPTS) {
            await sleep(BACKGROUND_LANE_NAMING_RETRY_DELAY_MS);
          }
        }
        if (suggested && suggested !== args.fallbackName) {
          await args.apply(suggested);
          if (canRefreshPinnedProject(args.pin)) {
            await refreshLanesStore().catch(() => undefined);
          }
        }
      } catch (error) {
        console.warn("background lane naming failed; keeping deterministic name", error);
      } finally {
        for (const id of args.flagLaneIds) setLaneNaming(id, false);
      }
    })();
  }, [canRefreshPinnedProject, refreshLanesStore]);

  // Single auto-created lane: rename it in place to the AI name.
  const startBackgroundLaneNaming = useCallback((args: {
    laneId: string;
    prompt: string;
    modelId: string;
    fallbackName: string;
    pin?: OpenProjectBinding | null;
  }) => {
    runBackgroundLaneNaming({
      ...args,
      flagLaneIds: [args.laneId],
      apply: (suggested) => args.pin
        ? window.ade.lanes.rename({ laneId: args.laneId, name: suggested }, args.pin)
        : window.ade.lanes.rename({ laneId: args.laneId, name: suggested }),
    });
  }, [runBackgroundLaneNaming]);

  // Parallel-models variant: each child lane is created instantly as
  // `<deterministicBase>-<modelSuffix>`. One background AI call produces the base
  // name, then every child is renamed to `<aiBase>-<modelSuffix>` in place. A
  // single child's rename failure must not abort the rest.
  const startBackgroundParallelLaneNaming = useCallback((args: {
    laneId: string;
    prompt: string;
    modelId: string;
    fallbackBase: string;
    children: Array<{ laneId: string; suffix: string }>;
    pin?: OpenProjectBinding | null;
  }) => {
    runBackgroundLaneNaming({
      laneId: args.laneId,
      prompt: args.prompt,
      modelId: args.modelId,
      fallbackName: args.fallbackBase,
      flagLaneIds: args.children.map((child) => child.laneId),
      apply: async (suggested) => {
        for (const child of args.children) {
          const renameArgs = { laneId: child.laneId, name: `${suggested}-${child.suffix}` };
          const rename = args.pin
            ? window.ade.lanes.rename(renameArgs, args.pin)
            : window.ade.lanes.rename(renameArgs);
          await rename
            .catch((error: unknown) => console.warn("background parallel lane rename failed", error));
        }
      },
    });
  }, [runBackgroundLaneNaming]);

  const resolveDraftLaunchLane = useCallback(async (
    snapshot: DraftLaunchSnapshot,
    onAutoCreateNameResolved?: () => void,
    onAutoCreateNameModelResolved?: (modelId: string) => void,
    assertActive?: () => void,
    pin?: OpenProjectBinding | null,
  ): Promise<DraftLaunchLaneTarget> => {
    if (draftLaunchTargetIsAutoCreate) {
      if (!laneId) throw new Error("Select a lane before auto-creating a new lane.");
      const primaryLane = availableLanes?.find((candidate) => candidate.laneType === "primary")
        ?? availableLanes?.find((candidate) => candidate.name.trim().toLowerCase() === "primary")
        ?? null;
      if (!primaryLane) throw new Error("Auto-create requires a primary lane.");
      const namingSeed = buildDraftLaunchNamingSeed(snapshot);
      const projectConfigSnapshot = await getProjectConfigCached({ projectRoot, pin, force: true }).catch(() => null);
      const titleSettings = projectConfigSnapshot?.effective?.ai?.sessionIntelligence?.titles;
      const titleModelId = typeof titleSettings?.modelId === "string" ? titleSettings.modelId.trim() : "";
      const namingModelId = titleModelId || snapshot.modelId;
      onAutoCreateNameModelResolved?.(namingModelId);
      const genericSuffix = autoLaneGenericSuffix();
      // Instant: name the lane deterministically now. If AI titles are enabled,
      // the real name is generated in the background after creation and applied
      // via lanes.rename — naming never blocks lane creation (no 10s race).
      const laneName = createDeterministicAutoLaneName(namingSeed, { genericSuffix });
      onAutoCreateNameResolved?.();
      assertActive?.();
      const baseSource = effectiveNewLaneBaseSource(projectConfigSnapshot);
      const branches = await fetchNewLaneBaseBranches({
        source: baseSource,
        fetchRemoteBranches: () => pin
          ? window.ade.git.fetch({ laneId: primaryLane.id }, pin)
          : window.ade.git.fetch({ laneId: primaryLane.id }),
        listBranches: () => pin
          ? window.ade.git.listBranches({ laneId: primaryLane.id }, pin)
          : window.ade.git.listBranches({ laneId: primaryLane.id }),
      });
      const primaryLaneSummary = lanes.find((candidate) => candidate.id === primaryLane.id) ?? null;
      const primaryBaseRef = primaryLaneSummary?.baseRef ?? (branchNameFromRef(primaryLane.branchRef) || "main");
      const selectedBaseBranch = selectDefaultNewLaneBaseRef({
        branches,
        source: baseSource,
        primaryBaseRef,
      });
      const baseBranch = selectedBaseBranch;
      assertActive?.();
      const createArgs = {
        name: laneName,
        ...(baseBranch ? { baseBranch } : {}),
      };
      const createdLane = pin
        ? await window.ade.lanes.create(createArgs, pin)
        : await window.ade.lanes.create(createArgs);
      // lanes.create is not cancellable, so if the launch timed out while it
      // was in flight, the outer wait has already rejected with targetLane ===
      // null and will not roll this lane back. Clean it up here, pinned to the
      // originating project, before returning.
      try {
        assertActive?.();
      } catch (abortError) {
        await window.ade.lanes.delete({ laneId: createdLane.id, force: true }, pin).catch((cleanupError: unknown) => {
          console.warn("draft launch lane cleanup after abort failed", cleanupError);
        });
        if (canRefreshPinnedProject(pin)) {
          await refreshLanesStore().catch(() => undefined);
        }
        throw abortError;
      }
      if (canRefreshPinnedProject(pin)) {
        await refreshLanesStore().catch((refreshError: unknown) => {
          console.warn("draft launch lane refresh failed", refreshError);
        });
      }
      if (titleSettings?.enabled !== false) {
        startBackgroundLaneNaming({
          laneId: createdLane.id,
          prompt: namingSeed,
          modelId: namingModelId,
          fallbackName: laneName,
          pin,
        });
      }
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
  }, [availableLanes, canRefreshPinnedProject, draftLaunchTargetIsAutoCreate, laneDisplayLabel, laneId, lanes, projectRoot, refreshLanesStore, startBackgroundLaneNaming]);

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
  }, [companionStateKey]);

  const cleanupDraftChatSession = useCallback(async (
    session: AgentChatSession,
    targetLane: DraftLaunchLaneTarget,
    pin?: OpenProjectBinding | null,
  ) => {
    // Pin the rollback to the project that owns the session so a concurrent
    // project switch can't route the delete at the now-active project.
    await window.ade.agentChat.delete({ sessionId: session.id }, pin).catch((cleanupError: unknown) => {
      console.warn("draft chat launch session cleanup failed", cleanupError);
    });
    loadedHistoryRef.current.delete(session.id);
    localTouchBySessionRef.current.delete(session.id);
    optimisticSessionIdsRef.current.delete(session.id);
    knownSessionIdsRef.current.delete(session.id);
    releaseRetainedChatSession(session.id);
    clearAgentChatSessionViewCacheForSessions([session.id]);
    invalidateSessionListCache();
    invalidateAgentChatSessionListCache({ laneId: targetLane.laneId });
    if (targetLane.laneId === laneId && canRefreshPinnedProject(pin)) {
      await refreshSessions({ force: true }).catch(() => undefined);
    }
  }, [canRefreshPinnedProject, laneId, refreshSessions]);

  const startDraftChatLaunch = useCallback(async (
    prepared: PreparedDraftLaunch,
    targetLane: DraftLaunchLaneTarget,
    pin?: OpenProjectBinding | null,
    assertActive?: () => void,
  ): Promise<StartedDraftLaunch> => {
    let createdSession: AgentChatSession | null = null;
    try {
      // Re-assert immediately before each mutating call (not just once up the
      // stack): a timed-out launch can keep its IPC work alive, so each step
      // checks that the renderer-side launch is still valid before continuing.
      assertActive?.();
      createdSession = await createSessionForLane(targetLane.laneId, { select: false, launchState: prepared, assertActive, pin });
      // Re-assert after creation: if the launch timed out while the session was
      // being created, abort now so the catch tears the session down rather
      // than sending into a stale launch.
      assertActive?.();
      touchSession(createdSession.id);
      const sendInteractionMode = createdSession.provider === "claude"
        ? createdSession.interactionMode ?? prepared.interactionMode
        : null;
      const sendArgs = {
        sessionId: createdSession.id,
        text: prepared.finalText,
        displayText: prepared.finalDisplayText || "Selected visual app context",
        attachments: prepared.selectedAttachments,
        contextAttachments: prepared.selectedContextAttachments,
        reasoningEffort: prepared.reasoningEffort,
        executionMode: prepared.executionMode,
        interactionMode: sendInteractionMode,
        ...(createdSession.provider === "cursor" ? { runtime: "local" as const } : {}),
      };
      if (pin) {
        await window.ade.agentChat.send(sendArgs, pin);
      } else {
        await window.ade.agentChat.send(sendArgs);
      }
      // If the launch timed out while the prompt was in flight, tear the
      // session down rather than leaving a started-but-orphaned chat.
      assertActive?.();
      if (canRefreshPinnedProject(pin)) {
        notifySessionCreated(createdSession, {
          activate: false,
          source: "draft-launch",
        });
      }
      return {
        sessionId: createdSession.id,
        draftKind: "chat",
      };
    } catch (launchError) {
      if (createdSession) {
        await cleanupDraftChatSession(createdSession, targetLane, pin);
      }
      throw launchError;
    }
  }, [
    cleanupDraftChatSession,
    canRefreshPinnedProject,
    createSessionForLane,
    notifySessionCreated,
    touchSession,
  ]);

  const startDraftCliLaunch = useCallback(async (
    prepared: PreparedDraftLaunch,
    targetLane: DraftLaunchLaneTarget,
    mode: DraftLaunchMode,
    assertActive?: () => void,
    pin?: OpenProjectBinding | null,
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
    const supportsFastMode = modelSupportsFastMode(desc);
    const launchFastMode = supportsFastMode
      ? prepared.fastMode
      : provider === "claude"
        ? false
        : undefined;
    const launchModel = desc.family === "cursor"
      ? resolveCursorCliModelVariant(desc, {
          reasoningEffort: prepared.reasoningEffort,
          fastMode: supportsFastMode && prepared.fastMode,
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
      ...((provider === "codex" || provider === "claude" || provider === "opencode") && launchFastMode !== undefined
        ? { fastMode: launchFastMode }
        : {}),
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
    // Final checkpoint before the PTY/session is spawned: abort if the launch
    // timed out while building the launch command.
    assertActive?.();
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
      pin,
    });
    // The PTY spawn is not cancellable, so if the launch was aborted while it
    // was starting (timeout), dispose the freshly-created
    // session instead of leaving an orphaned terminal in the wrong project.
    try {
      assertActive?.();
    } catch (abortError) {
      // Pin the dispose to the originating project so a concurrent switch can't
      // route it at the now-active runtime (or throw under the transition guard).
      await window.ade.pty.dispose({ ptyId: result.ptyId, sessionId: result.sessionId }, pin).catch((disposeError: unknown) => {
        console.warn("draft cli launch pty cleanup failed", disposeError);
      });
      throw abortError;
    }
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
    if (kind === "chat" && (selectedSessionId || workDraftKind !== "chat")) return;
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

    // Pin this launch to the project that started it. The chain runs detached
    // from the pane's lifecycle, so if the user switches projects mid-launch the
    // lane/session/send calls keep targeting the originating runtime instead of
    // the now-active project. `launchBinding` is this pane's project-scoped
    // binding; the root store's binding tracks whichever project is currently
    // active.
    //
    // `launchTimedOut` is the normal abort source: withDraftLaunchTimeout rejects
    // the renderer wait but cannot cancel the underlying IPC, so a timed-out
    // step that keeps running must be stopped before its next mutation.
    const launchBinding = projectBinding;
    const launchProjectRoot = projectRoot;
    let launchTimedOut = false;
    const assertLaunchActive = () => {
      if (launchTimedOut) {
        throw new Error("Draft launch aborted after timeout.");
      }
      // Bound launches are intentionally routed by `launchBinding`; this abort
      // is only for legacy/unpinned launches where the active project is the
      // only routing signal left.
      if (!launchBinding && launchProjectRoot) {
        const activeProjectRoot = selectActiveProjectRoot(rootAppStoreApi.getState());
        if (activeProjectRoot && activeProjectRoot !== launchProjectRoot) {
          throw new Error(LAUNCH_PROJECT_CHANGED_MESSAGE);
        }
      }
    };
    const markLaunchTimedOut = () => {
      launchTimedOut = true;
    };

    const jobId = createDraftLaunchJobId();
    if (mode === "foreground") {
      latestForegroundDraftLaunchJobIdRef.current = jobId;
    }
    const job: DraftLaunchJob = {
      id: jobId,
      mode,
      draftKind: kind,
      // Auto-create no longer blocks on naming (deterministic name now, AI rename
      // in the background), so the launch goes straight to lane creation.
      status: draftLaunchTargetIsAutoCreate ? "creating-lane" : "starting-session",
      title: buildDraftLaunchJobTitle(kind, snapshot),
      laneId: null,
      laneName: null,
      sessionId: null,
      namingModelId: null,
      error: null,
      warning: null,
      autoOpen: mode === "foreground",
      createdAtMs: Date.now(),
      snapshot,
    };
    clearPromptSuggestionForSession(selectedSessionId);
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
      targetLane = await withDraftLaunchTimeout(resolveDraftLaunchLane(snapshot, () => {
        patchDraftLaunchJob(jobId, { status: "creating-lane" });
      }, (modelId) => {
        patchDraftLaunchJob(jobId, { namingModelId: modelId });
      }, assertLaunchActive, launchBinding), "Lane setup", markLaunchTimedOut);
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
      // Re-check before starting the session. The start functions also re-assert
      // immediately before each of their own mutating calls.
      assertLaunchActive();
      const launched = await withDraftLaunchTimeout(
        kind === "chat"
          ? startDraftChatLaunch(prepared, targetLane, launchBinding, assertLaunchActive)
          : startDraftCliLaunch(prepared, targetLane, mode, assertLaunchActive, launchBinding),
        "Session start",
        markLaunchTimedOut,
      );
      invalidateSessionListCache();
      invalidateAgentChatSessionListCache({ laneId: targetLane.laneId });
      if (launched.draftKind === "chat" && targetLane.laneId === laneId && canRefreshPinnedProject(launchBinding)) {
        void refreshSessions({ force: true }).catch(() => {});
      }
      const launch = {
        laneId: targetLane.laneId,
        laneName: targetLane.laneName,
        sessionId: launched.sessionId,
        draftKind: launched.draftKind,
      };
      const canMutateLaunchUi = canRefreshPinnedProject(launchBinding);
      const shouldAutoOpen =
        canMutateLaunchUi && mode === "foreground" && latestForegroundDraftLaunchJobIdRef.current === jobId;
      const jobStillVisible = draftLaunchJobExists(jobId);
      patchDraftLaunchJob(jobId, {
        status: "ready",
        laneId: launch.laneId,
        laneName: launch.laneName,
        sessionId: launch.sessionId,
        draftKind: launch.draftKind,
        // Keep autoOpen set for foreground sends so the effect below can open the
        // chat even if this pane instance remounted during the launch (otherwise
        // the inline open is skipped and the job sits at "ready").
        autoOpen: mode === "foreground" && canMutateLaunchUi,
      });
      if (!jobStillVisible) {
        return;
      }
      if (shouldAutoOpen && paneMountedRef.current) {
        openLaunchedDraftSession({ ...launch, jobId });
      } else if (canMutateLaunchUi && mode === "background" && paneMountedRef.current) {
        setSelectedSessionId(null);
      }
    } catch (launchError) {
      if (targetLane?.autoCreated) {
        // Pin the rollback to the originating project so it deletes the lane we
        // created, even if the active project has since changed.
        await window.ade.lanes.delete({ laneId: targetLane.laneId, force: true }, launchBinding).catch((cleanupError: unknown) => {
          console.warn(`draft ${kind} launch lane cleanup failed`, cleanupError);
        });
        if (canRefreshPinnedProject(launchBinding)) {
          await refreshLanesStore().catch(() => undefined);
        }
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
    canRefreshPinnedProject,
    clearPromptSuggestionForSession,
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
    projectBinding,
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
    if (!canShowHandoff || !selectedSessionId || !handoffModelId || handoffBlocked || handoffBusy) return;
    const sourceLaneId = selectedSession?.laneId ?? laneId;
    if (!sourceLaneId) return;
    const jobId = createHandoffLaunchJobId();
    const patchHandoffJob = (patch: Partial<HandoffLaunchJob>) => {
      setHandoffLaunchJobs((current) => current.map((job) => (
        job.id === jobId ? { ...job, ...patch } : job
      )));
    };
    const targetModelLabel = handoffTargetDescriptor?.displayName
      ?? formatLocalModelLabel(handoffModelId);
    setHandoffLaunchJobs((current) => [
      {
        id: jobId,
        sourceSessionId: selectedSessionId,
        laneId: sourceLaneId,
        laneName: laneDisplayLabel ?? sourceLaneId,
        targetModelId: handoffModelId,
        targetModelLabel,
        targetToolType: handoffTargetProvider ? chatToolTypeForProvider(handoffTargetProvider) : "other",
        // One honest per-mode label for the whole operation; the renderer
        // cannot observe runtime-side stage transitions, and fake timed stage
        // hops misreported where a slow handoff actually was.
        status: mode === "fork" ? "forking-history" : "preparing-summary",
        createdAtMs: Date.now(),
      },
      ...current.filter((job) => job.sourceSessionId !== selectedSessionId),
    ]);
    setError(null);
    setHandoffBusy(true);
    setChatActionsOpen(false);
    try {
      const resolvedHandoffPermissionMode = handoffNativePermissionMode ?? selectedSession?.permissionMode;
      const trimmedHandoffNote = handoffNote.trim();
      // Brief handoffs may target another lane (or a freshly created one); fork
      // always stays in the source lane because provider transcripts are keyed
      // to the source worktree.
      let resolvedTargetLaneId: string | undefined;
      if (mode === "brief") {
        if (handoffTargetLaneId === AUTO_CREATE_LANE_OPTION_ID) {
          const seed = trimmedHandoffNote || (selectedSession ? chatSessionTitle(selectedSession) : "") || "handoff";
          const laneName = createDeterministicAutoLaneName(seed, { genericSuffix: autoLaneGenericSuffix() });
          const createdLane = await window.ade.lanes.create({ name: laneName });
          resolvedTargetLaneId = createdLane.id;
          patchHandoffJob({ laneId: createdLane.id, laneName });
          await refreshLanesStore().catch(() => {});
        } else if (handoffTargetLaneId && handoffTargetLaneId !== sourceLaneId) {
          resolvedTargetLaneId = handoffTargetLaneId;
          // Re-home the sidebar placeholder to the lane the new chat will
          // actually appear in.
          patchHandoffJob({
            laneId: handoffTargetLaneId,
            laneName: availableLanes?.find((lane) => lane.id === handoffTargetLaneId)?.name ?? handoffTargetLaneId,
          });
        }
      }
      const result = await window.ade.agentChat.handoff({
        sourceSessionId: selectedSessionId,
        targetModelId: handoffModelId,
        mode,
        ...(resolvedTargetLaneId ? { targetLaneId: resolvedTargetLaneId } : {}),
        ...(trimmedHandoffNote ? { handoffNote: trimmedHandoffNote } : {}),
        reasoningEffort: handoffReasoningEffort,
        ...(handoffTargetProvider === "codex" || handoffTargetProvider === "opencode"
          ? { fastMode: handoffFastMode }
          : {}),
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
      notifySessionCreated(result.session, { source: "handoff" });
      setHandoffNote("");
      invalidateCurrentChatSessionList();
      void refreshSessions({ force: true }).catch(() => {});
    } catch (handoffError) {
      const rawMessage = handoffError instanceof Error ? handoffError.message : String(handoffError);
      // A transport timeout abandons the RPC but does not cancel the
      // daemon-side handoff, which usually still completes. Say so instead of
      // reporting a hard failure, and re-poll the session list so a late
      // success surfaces as the expected new chat, not a surprise. Match ONLY
      // the two transport wrappers (registerIpc invoke timeout, RuntimeRpcClient
      // request timeout) — daemon-internal errors also say "timed out after Nms"
      // but those are real failures that must surface as errors.
      const isTransportTimeout = isRuntimeTransportTimeoutError(handoffError);
      const message = isTransportTimeout
        ? "The handoff is taking longer than expected. ADE is still finishing it in the background — if it completes, the new chat will appear in the session list."
        : rawMessage;
      setError(message);
      if (isTransportTimeout) {
        for (const delayMs of [20_000, 60_000, 120_000]) {
          window.setTimeout(() => {
            if (!paneMountedRef.current) return;
            invalidateCurrentChatSessionList();
            void refreshSessions({ force: true }).catch(() => {});
          }, delayMs);
        }
      }
      if (handoffErrorClearTimerRef.current != null) {
        window.clearTimeout(handoffErrorClearTimerRef.current);
      }
      handoffErrorClearTimerRef.current = window.setTimeout(() => {
        handoffErrorClearTimerRef.current = null;
        setError((current) => (current === message ? null : current));
      }, isTransportTimeout ? 12000 : 6000);
    } finally {
      setHandoffLaunchJobs((current) => current.filter((job) => job.id !== jobId));
      setHandoffBusy(false);
    }
  }, [
    availableLanes,
    canShowHandoff,
    handoffBlocked,
    handoffBusy,
    handoffClaudePermissionMode,
    handoffCodexApprovalPolicy,
    handoffCodexConfigSource,
    handoffTargetDescriptor,
    handoffFastMode,
    handoffCodexSandbox,
    handoffCursorConfigValues,
    handoffCursorModeId,
    handoffDroidPermissionMode,
    handoffModelId,
    handoffNote,
    handoffNativePermissionMode,
    handoffOpenCodePermissionMode,
    handoffReasoningEffort,
    handoffTargetLaneId,
    handoffTargetProvider,
    invalidateCurrentChatSessionList,
    laneDisplayLabel,
    laneId,
    notifySessionCreated,
    refreshLanesStore,
    refreshSessions,
    selectedSession,
    selectedSessionId,
    setHandoffLaunchJobs,
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
        // The chat is gone: stop retaining its stream and drop its cached view
        // rather than waiting for the retention TTL / cache pressure.
        releaseRetainedChatSession(selectedSessionId);
        clearAgentChatSessionViewCacheForSessions([selectedSessionId]);
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

  const submit = useCallback(async (activeTurnDispatchMode?: AgentChatDispatchSteerMode) => {
    // A turn is about to run against this worktree — surface the branch-drift
    // strip if HEAD has wandered off the lane's branch. No-op when it hasn't.
    armLaneBranchDriftWarning(laneId);
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
          || builtInBrowserContextItems.length > 0;
        if (hasUnsupportedRevisionContext) {
          setError("Plan revisions from the ready gate are text-only. Remove attachments or click Keep planning first.");
          return;
        }
        clearPromptSuggestionForSession(selectedSessionId);
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
    clearPromptSuggestionForSession(selectedSessionId);

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
        const projectConfigSnapshot = await getProjectConfigCached({ projectRoot, force: false }).catch(() => null);
        const titleSettings = projectConfigSnapshot?.effective?.ai?.sessionIntelligence?.titles;
        const titleModelId = typeof titleSettings?.modelId === "string" ? titleSettings.modelId.trim() : "";
        const namingModelId = titleModelId || parallelModelSlots[0]!.modelId;
        const genericSuffix = autoLaneGenericSuffix();
        // Instant: name child lanes deterministically now. If AI titles are
        // enabled, the real base name is generated in the background after the
        // lanes exist and applied to each child via lanes.rename (no 10s race).
        const baseName = createDeterministicAutoLaneName(namingSeed, { genericSuffix });
        const childLaneNamings: Array<{ laneId: string; suffix: string }> = [];
        setParallelLaunchStatus(`Creating ${parallelModelSlots.length} child lanes…`);

        for (const slot of parallelModelSlots) {
          const desc = getModelById(slot.modelId);
          const suffix = parallelLaneModelSuffix(desc);
          const laneName = `${baseName}-${suffix}`;
          const childLane = await window.ade.lanes.createChild({ parentLaneId: laneId, name: laneName });
          createdLaneIds.push(childLane.id);
          childLaneNamings.push({ laneId: childLane.id, suffix });
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
            ...(modelSupportsFastMode(desc) ? { fastMode: slot.fastMode } : {}),
            ...buildNativeControlPayloadForSlot(slot, provider),
          });
          sessionByLane.set(childLane.id, created.id);
        }

        await refreshLanesStore();

        if (titleSettings?.enabled !== false) {
          startBackgroundParallelLaneNaming({
            laneId,
            prompt: namingSeed,
            modelId: namingModelId,
            fallbackBase: baseName,
            children: childLaneNamings,
          });
        }

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
    const contextAttachmentsSnapshot = [...contextAttachments];
    const iosContextPrefix = formatIosElementContextForPrompt(iosContextSnapshot);
    const appControlContextPrefix = formatAppControlContextForPrompt(appControlContextSnapshot);
    const builtInBrowserContextPrefix = formatBuiltInBrowserContextForPrompt(builtInBrowserContextSnapshot);
    const iosContextDisplayChips = formatIosElementContextChipsForDisplay(iosContextSnapshot);
    const appControlContextDisplayChips = formatAppControlContextChipsForDisplay(appControlContextSnapshot);
    const builtInBrowserContextDisplayChips = formatBuiltInBrowserContextChipsForDisplay(builtInBrowserContextSnapshot);
    const visualContextPrefix = [iosContextPrefix, appControlContextPrefix, builtInBrowserContextPrefix].filter(Boolean).join("\n");
    const visualContextDisplayChips = [iosContextDisplayChips, appControlContextDisplayChips, builtInBrowserContextDisplayChips].filter(Boolean).join(" ");
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
    const pendingFastModeUpdate = pendingFastModeUpdateRef.current;
    if (selectedSessionId && pendingFastModeUpdate?.sessionId === selectedSessionId) {
      try {
        await pendingFastModeUpdate.promise;
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
    // Populated only when the draft is submitted as a steer. Immediate Claude
    // delivery is already atomic inside steer({ dispatchMode }); queued sends
    // return the id used by the staged-message controls.
    let steerResult: AgentChatSteerResult | null = null;

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
    // Awaiting session-create roundtrips before this setter delays the bubble
    // by hundreds of ms on a typical send.
    const selectedAttachmentsForOptimistic = isLiteralSlashCommand ? [] : attachmentsSnapshot;
    const selectedContextAttachmentsForOptimistic = isLiteralSlashCommand ? [] : contextAttachmentsSnapshot;
    const optimisticDisplayText = visualContextDisplayChips
      ? text.length
        ? `${visualContextDisplayChips} ${text}`
        : visualContextDisplayChips
      : text.length
        ? text
        : attachmentsSnapshot.length
          ? DEFAULT_PARALLEL_ATTACHMENT_REQUEST
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
      let justCreatedSession = false;
      const finalTextPrefix = visualContextPrefix;
      let finalText = finalTextPrefix ? `${finalTextPrefix}${text}` : text;
      if (!finalText.trim().length && attachmentsSnapshot.length) {
        finalText = DEFAULT_PARALLEL_ATTACHMENT_REQUEST;
      } else if (!finalText.trim().length && contextAttachmentsSnapshot.length) {
        finalText = "Use the attached issue context.";
      }
      const finalDisplayText = visualContextDisplayChips
        ? text.length
          ? `${visualContextDisplayChips} ${text}`
          : visualContextDisplayChips
        : text.length
          ? text
          : attachmentsSnapshot.length
            ? DEFAULT_PARALLEL_ATTACHMENT_REQUEST
            : "Attached issue context";

      let sessionId = selectedSessionId;
      const shouldPromoteLightSession = shouldPromoteSessionForComputerUse(selectedSession);
      const selectedModelChanged =
        Boolean(selectedSessionId)
        && Boolean(selectedSessionModelId)
        && selectedSessionModelId !== modelId;
      const selectedFastModeChanged =
        Boolean(selectedSessionId)
        && selectedSession?.provider === "codex"
        && (selectedSession.fastMode === true) !== fastMode;
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
        || selectedFastModeChanged
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
          ...(modelSupportsFastMode(desc) ? { fastMode } : {}),
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

      const steerMessage = async (): Promise<AgentChatSteerResult> => {
        return await window.ade.agentChat.steer({
          sessionId,
          text: finalText,
          displayText: finalDisplayText,
          ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
          ...(selectedContextAttachments.length ? { contextAttachments: selectedContextAttachments } : {}),
          ...(sessionProvider === "claude" && activeTurnDispatchMode ? { dispatchMode: activeTurnDispatchMode } : {}),
        });
      };

      const sendMessageOrSteerIfBusy = async (retryOnStaleSteer = true) => {
        try {
          setOptimisticIfAllowed(sessionId);
          const sendInteractionMode: AgentChatInteractionMode | null =
            sessionProvider === "claude"
              ? (
                orchestratorEnabled || selectedSession?.interactionMode === "orchestrator-lead"
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
              // Capture the result so a stale-turn-active race still flows
              // through the queue_full restore path and the inline send-now
              // dispatch, exactly like the direct steer branch below.
              steerResult = await steerMessage();
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
          steerResult = await steerMessage();
        } catch (steerError) {
          if (!isNoActiveTurnToSteerError(steerError)) throw steerError;
          setTurnActiveBySession((prev) => ({ ...prev, [sessionId]: false }));
          await sendMessageOrSteerIfBusy();
        }
      } else {
        await sendMessageOrSteerIfBusy();
      }
      if (steerResult?.reason === "queue_full") {
        // The steer queue is full — the backend dropped the message (and emitted
        // its own notice). Restore the composer rather than clearing it as if the
        // send succeeded, and surface a brief inline notice. Returning null keeps
        // the caller from dispatching a message that was never accepted.
        setDraft((current) => (current.trim().length ? current : draftSnapshot));
        setAttachments((current) => (current.length ? current : attachmentsSnapshot));
        setContextAttachments((current) => (current.length ? current : contextAttachmentsSnapshot));
        setIosElementContextItems((current) => (current.length ? current : iosContextSnapshot));
        setAppControlContextItems((current) => (current.length ? current : appControlContextSnapshot));
        setBuiltInBrowserContextItems((current) => (current.length ? current : builtInBrowserContextSnapshot));
        setError("Message not sent — the queue is full. Wait for the current turn to finish, then resend.");
        return null;
      }
      // Skip refresh when we just created the session — createSession already triggered one.
      // A redundant refresh here causes flicker as it re-resolves session selection.
      if (!justCreatedSession) {
        await refreshSessions().catch(() => {});
      }
      setIosElementContextItems([]);
      setAppControlContextItems([]);
      setBuiltInBrowserContextItems([]);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setDraft((current) => (current.trim().length ? current : draftSnapshot));
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setContextAttachments((current) => (current.length ? current : contextAttachmentsSnapshot));
      setIosElementContextItems((current) => (current.length ? current : iosContextSnapshot));
      setAppControlContextItems((current) => (current.length ? current : appControlContextSnapshot));
      setBuiltInBrowserContextItems((current) => (current.length ? current : builtInBrowserContextSnapshot));
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
    return steerResult;
  }, [
    attachments,
    buildNativeControlPayload,
    busy,
    clearPromptSuggestionForSession,
    fastMode,
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
    startBackgroundParallelLaneNaming,
    persistParallelLaunchState,
    setWorkViewState,
    setLaneWorkViewState,
    iosElementContextItems,
    appControlContextItems,
    builtInBrowserContextItems,
    workDraftKind,
    orchestratorEnabled,
  ]);

  // Staged-row dispatch/edit remain fire-and-forget IPC. New active-turn sends
  // are atomic through steer({ dispatchMode }) and never enter the staged queue.
  const dispatchSteerSafely = useCallback(
    (args: { sessionId: string; steerId: string; mode: AgentChatDispatchSteerMode }) => {
      void window.ade.agentChat.dispatchSteer(args).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        setError(`Couldn't deliver the message to the running turn: ${message}`);
      });
    },
    [],
  );

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

  // Row-facing handlers for AgentChatMessageList are stabilized so a draft-only
  // keystroke (which rerenders this pane) does not change the memoized transcript
  // boundary's props. Each still observes current session/turn/model/lane state
  // through its dependency list, so retry/recovery/model-picker behavior is
  // unchanged. Do NOT depend on the draft here.
  const handleListApproval = useCallback(
    (
      itemId: string,
      decision: AgentChatApprovalDecision,
      responseText?: string | null,
      answers?: Record<string, string | string[]>,
    ) => {
      void handleApproval(itemId, decision, responseText, answers);
    },
    [handleApproval],
  );
  const handleListCodexRecovery = useCallback(
    async (args: AgentChatRecoverCodexTurnArgs) => {
      const action = args.action === "steer"
        ? "nudge"
        : args.action === "interrupt_retry_same_thread"
          ? "retry_same_runtime"
          : args.action === "restart_resume_thread"
            ? "restart_resume"
            : "wait";
      try {
        const result = await window.ade.agentChat.recoverTurn({
          sessionId: args.sessionId,
          turnId: args.turnId,
          action,
        });
        return {
          ...result,
          action: args.action,
        };
      } catch (error) {
        if (!isUnsupportedAgentChatRecoveryActionError(error)) throw error;
        return window.ade.agentChat.recoverCodexTurn(args);
      }
    },
    [],
  );
  const handleRunUnprocessedMessage = useCallback(
    async (event: Extract<AgentChatEvent, { type: "user_message" }>) => {
      const sessionId = selectedSessionIdRef.current;
      if (!sessionId) throw new Error("This chat is no longer selected.");
      if (turnActiveBySessionRef.current[sessionId]) {
        throw new Error("A turn is already active. Wait for it to finish, then run this message.");
      }
      if (submitInFlightRef.current) {
        throw new Error("Another message is already being sent.");
      }
      try {
        submitInFlightRef.current = true;
        setBusy(true);
        setError(null);
        touchSession(sessionId);
        const steerId = event.steerId?.trim();
        if (!steerId) throw new Error("This message is missing its durable delivery identifier.");
        await window.ade.agentChat.resolveUnprocessedMessage({
          sessionId,
          steerId,
          action: "run_next",
        });
        void refreshSessions().catch(() => {});
      } catch (runError) {
        const message = runError instanceof Error ? runError.message : String(runError);
        setError(message);
        throw runError;
      } finally {
        submitInFlightRef.current = false;
        setBusy(false);
      }
    },
    [refreshSessions, touchSession],
  );
  const handleEditUnprocessedMessage = useCallback(
    (event: Extract<AgentChatEvent, { type: "user_message" }>) => {
      insertComposerDraft(event.displayText?.trim() || event.text);
    },
    [insertComposerDraft],
  );
  const handleDismissUnprocessedMessage = useCallback(
    async (event: Extract<AgentChatEvent, { type: "user_message" }>) => {
      const sessionId = selectedSessionIdRef.current;
      const steerId = event.steerId?.trim();
      if (!sessionId) throw new Error("This chat is no longer selected.");
      if (!steerId) throw new Error("This message is missing its durable delivery identifier.");
      await window.ade.agentChat.resolveUnprocessedMessage({
        sessionId,
        steerId,
        action: "dismiss",
      });
      void refreshSessions().catch(() => {});
    },
    [refreshSessions],
  );
  const handleListRetryProviderFailure = useCallback(
    async (failedTurnId: string | null) => {
      if (!selectedSessionId) return "This chat is no longer selected.";
      if (turnActive) return "A turn is already active in this thread. Wait for it to finish before retrying.";
      return resendLastUserMessage(selectedSessionId, failedTurnId);
    },
    [resendLastUserMessage, selectedSessionId, turnActive],
  );
  const handleListChooseProviderFailureModel = useCallback(() => {
    if (turnActive) return;
    setModelPickerOpenRequest((request) => ({
      key: (request?.key ?? 0) + 1,
      sessionId: modelPickerOpenRequestSessionId,
      laneId,
    }));
  }, [laneId, modelPickerOpenRequestSessionId, turnActive]);

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

  const handleFastModeChange = useCallback((enabled: boolean) => {
    const previousFastMode = fastMode;
    if (!selectedSessionId) {
      draftLaunchConfigTouchedKeyRef.current = draftLaunchConfigScopeKey;
    }
    setFastMode(enabled);
    if (!selectedSessionId) return;
    if (isPersistentIdentitySurface && sessionMutationKind) return;

    const updateId = ++fastModeUpdateCounterRef.current;
    const targetSessionId = selectedSessionId;
    patchSessionSummary(targetSessionId, { fastMode: enabled });
    // Serialize the IPC writes: chain off any in-flight fast-mode update for the
    // same session so two rapid toggles persist in order. The prior mutation
    // already surfaced its own error, so swallow it here before issuing ours.
    const previousUpdate = pendingFastModeUpdateRef.current?.sessionId === targetSessionId
      ? pendingFastModeUpdateRef.current.promise
      : null;
    const updatePromise = Promise.resolve(previousUpdate)
      .catch(() => {})
      .then(() => window.ade.agentChat.updateSession({
        sessionId: targetSessionId,
        fastMode: enabled,
      }))
      .then((updatedSession) => {
      if (updateId !== fastModeUpdateCounterRef.current) return;
      const reconciled = updatedSession.fastMode === true;
      patchSessionSummary(targetSessionId, { fastMode: reconciled });
      if (selectedSessionIdRef.current === targetSessionId) {
        setFastMode(reconciled);
      }
      void refreshSessions().catch(() => {});
    }).catch((err) => {
      if (updateId === fastModeUpdateCounterRef.current
        && selectedSessionIdRef.current === targetSessionId) {
        setFastMode(previousFastMode);
        patchSessionSummary(targetSessionId, { fastMode: previousFastMode });
      }
      void refreshSessions().catch(() => {});
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }).finally(() => {
      const pending = pendingFastModeUpdateRef.current;
      if (pending?.sessionId === targetSessionId && pending.updateId === updateId) {
        pendingFastModeUpdateRef.current = null;
      }
    });
    pendingFastModeUpdateRef.current = {
      sessionId: targetSessionId,
      updateId,
      promise: updatePromise,
    };
    void updatePromise.catch(() => {});
  }, [
    fastMode,
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
  const agentsTabContent = selectedSubagentPaneAvailable || selectedTodoItems.length > 0 || selectedScheduledWorkSnapshots.length > 0 ? (
    <ChatSubagentsPanel
      sessionId={selectedSessionId}
      snapshots={selectedSubagentSnapshots}
      events={selectedEvents}
      todoItems={selectedTodoItems}
      scheduleItems={selectedScheduleItems}
      backgroundItems={selectedBackgroundItems}
      schedulesPaused={selectedSession?.scheduledWorkPaused === true}
      onToggleSchedulesPaused={selectedSessionId ? () => {
        const paused = selectedSession?.scheduledWorkPaused !== true;
        void window.ade.agentChat.setScheduledWorkPaused({
          sessionId: selectedSessionId,
          paused,
        }).then((result) => {
          patchSessionSummary(selectedSessionId, {
            scheduledWorkPaused: result.paused,
            nextWakeAt: result.nextWakeAt,
          });
        }).catch((pauseError) => {
          setError(pauseError instanceof Error ? pauseError.message : String(pauseError));
        });
      } : undefined}
      onCancelScheduledWork={selectedSessionId ? (schedule) => {
        void window.ade.agentChat.cancelScheduledWork({
          sessionId: selectedSessionId,
          scheduleId: schedule.id,
        }).then((result) => {
          const current = selectedSession?.scheduledWork ?? [];
          patchSessionSummary(selectedSessionId, {
            scheduledWork: result.providerCancellationConfirmed || result.schedule.status === "cancelled"
              ? current.filter((item) => item.id !== schedule.id)
              : current.map((item) => item.id === schedule.id ? result.schedule : item),
          });
          scheduleSessionsRefresh();
        }).catch((cancelError) => {
          setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
        });
      } : undefined}
      variant="pane"
      className="h-full"
      onSelectSubagent={(selection) => {
        setSubagentView({
          taskId: selection.taskId,
          agentId: selection.agentId,
          agentType: selection.agentType,
          status: selection.status,
          background: selection.background,
        });
      }}
      onClearSelectedSubagent={() => setSubagentView(null)}
      probeSubagentTranscript={probeSubagentTranscript}
      resolveSpawnedChatTitle={resolveSpawnedChatTitle}
      capability={selectedSubagentCapability}
      selectedTaskId={subagentView?.taskId ?? null}
      goal={selectedSession?.provider === "codex" ? selectedCodexGoal : null}
      claudeGoal={selectedSession?.provider === "claude" ? selectedClaudeGoal : null}
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
      onSetGoalStatus={
        selectedSession?.provider === "codex" && selectedSessionId
          ? (status) => {
              void setCodexGoalStatusFromPanel(selectedSessionId, status);
            }
          : undefined
      }
    />
  ) : (
    <div className="flex h-full min-h-0 flex-col items-center justify-center px-4 py-8 text-center">
      <p className="font-sans text-[13px] text-fg/50">No agent activity detected</p>
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
  const handoffTurnGate = turnActive || selectedSessionAwaitingInput;
  const handoffSourceProviderLabel = handoffProviderDisplayName(selectedSession?.provider);
  const handoffLaneSourceLanes = availableLanes ?? lanes;
  const handoffLaneOptions = handoffLaneSourceLanes.length
    ? [AUTO_CREATE_LANE_OPTION, ...handoffLaneSourceLanes]
    : [AUTO_CREATE_LANE_OPTION];
  // Provider-native permission controls, shared by the fork and brief tabs.
  const handoffPermissionControls = handoffTargetProvider ? (
    <div className="space-y-1.5">
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
            title={handoffCodexPermissionPreset === "custom" ? "Non-standard policy; choosing a mode replaces it." : undefined}
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
            aria-label="Codex permission mode for handoff"
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
                handoffFastMode
                  ? "border-amber-300/28 bg-amber-400/12 text-amber-100"
                  : "border-white/[0.08] bg-white/[0.03] text-muted-fg/62 hover:bg-white/[0.06] hover:text-fg/78",
              )}
              aria-pressed={handoffFastMode}
              aria-label="Fast mode for handoff"
              onClick={() => setHandoffFastMode((current) => !current)}
            >
              <Lightning size={12} weight="fill" />
              Fast
            </button>
          ) : null}
          {handoffCodexPermissionPreset === "custom" ? (
            <div className="text-[10px] text-amber-200/55">Session uses a custom policy; select a standard mode to apply to the new chat.</div>
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
  ) : null;
  const handoffNoteField = (caption: string) => (
    <div className="space-y-1">
      <label className="block space-y-1">
        <span className="font-sans text-[10px] font-medium uppercase tracking-[0.12em] text-muted-fg/45">Extra instructions</span>
        <textarea
          value={handoffNote}
          onChange={(event) => setHandoffNote(event.target.value)}
          rows={3}
          maxLength={4000}
          placeholder="What should the new chat pick up from here?"
          className="min-h-[68px] w-full resize-y rounded-md border border-white/[0.08] bg-black/20 px-2.5 py-2 font-sans text-[11px] leading-4 text-fg/80 outline-none transition-colors placeholder:text-muted-fg/35 focus:border-[color:color-mix(in_srgb,var(--chat-accent)_32%,transparent)]"
        />
      </label>
      <span className="block text-[10px] leading-4 text-fg/38">{caption}</span>
    </div>
  );
  const handoffMenuView = (
    <div data-testid="handoff-menu" className="min-h-0 flex-1 overflow-auto p-4">
      <div className="mb-3 space-y-0.5">
        <div className="font-sans text-[12px] font-semibold text-fg/82">Hand off this chat</div>
        <div className="text-[11px] leading-4 text-fg/50">Continue the work somewhere new — another machine, or a fresh chat here.</div>
      </div>
      <div className="relative">
        <div
          className={cn("space-y-2.5", handoffTurnGate && "pointer-events-none select-none opacity-40")}
          aria-disabled={handoffTurnGate || undefined}
        >
          <HandoffMenuCard
            tone="remote"
            icon={Desktop}
            title="Continue on another machine"
            description="Move this chat to another computer running ADE."
            disabled={isRemoteProject || handoffTurnGate}
            footnote={isRemoteProject ? "Start this from the machine that owns the project." : null}
            onClick={() => setCrossMachineHandoffOpen(true)}
          />
          <HandoffMenuCard
            tone="local"
            icon={GitFork}
            title="Hand off locally"
            description="Start a new chat from this one — fork the thread or send a brief."
            disabled={handoffTurnGate}
            onClick={() => {
              setHandoffLocalMode(handoffForkSupported ? "fork" : "brief");
              setHandoffView("local");
            }}
          />
        </div>
        {handoffTurnGate ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center p-3">
            <div className="pointer-events-auto max-w-[220px] rounded-lg border border-amber-300/22 bg-[color:color-mix(in_srgb,#f59e0b_16%,#11131a)] px-3 py-2 text-center text-[10.5px] font-medium leading-4 text-amber-100/90 shadow-[0_10px_30px_-12px_rgba(0,0,0,0.7)]">
              A turn is running — wait for it to finish before handing off.
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
  const handoffForkTabDisabled = !handoffForkSupported;
  const handoffLocalView = (
    <div data-testid="handoff-local" className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-2.5 border-b border-white/[0.06] px-4 py-3">
        <button
          type="button"
          aria-label="Back to handoff options"
          onClick={() => setHandoffView("menu")}
          className="mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-md border border-white/[0.07] bg-white/[0.03] text-fg/55 transition-colors hover:border-white/[0.14] hover:text-fg/85"
        >
          <ArrowLeft size={13} />
        </button>
        <div className="min-w-0">
          <div className="font-sans text-[12.5px] font-semibold text-fg/88">Local handoff</div>
          <div className="mt-0.5 text-[10.5px] leading-4 text-fg/48">Fork copies the whole conversation. Brief summarizes it and starts fresh.</div>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <div className="inline-flex w-full rounded-lg border border-white/[0.07] bg-white/[0.02] p-0.5">
          {([
            { mode: "fork" as const, label: "Fork", disabled: handoffForkTabDisabled },
            { mode: "brief" as const, label: "Brief", disabled: false },
          ]).map(({ mode, label, disabled }) => {
            const active = handoffLocalMode === mode;
            return (
              <button
                key={mode}
                type="button"
                disabled={disabled}
                aria-pressed={active}
                onClick={() => setHandoffLocalMode(mode)}
                className={cn(
                  "flex-1 rounded-md px-3 py-1.5 font-sans text-[11px] font-semibold transition-colors",
                  active
                    ? "bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] text-fg/90 shadow-[inset_0_0_0_1px_color-mix(in_srgb,var(--chat-accent)_26%,transparent)]"
                    : "text-fg/52 hover:text-fg/78",
                  disabled && "cursor-not-allowed opacity-40 hover:text-fg/52",
                )}
              >
                {label}
              </button>
            );
          })}
        </div>
        {handoffForkTabDisabled ? (
          <div className="mt-1.5 text-[10px] leading-4 text-fg/42">
            {handoffSourceProviderLabel} can&rsquo;t fork chat history — use a brief instead.
          </div>
        ) : null}

        {handoffLocalMode === "fork" && !handoffForkTabDisabled ? (
          <div className="mt-3 space-y-3">
            <div className="text-[11px] leading-5 text-fg/54">
              Forks the full conversation through {handoffSourceProviderLabel}&rsquo;s native fork{laneId ? <> and stays in this lane ({laneDisplayLabel})</> : null}.
            </div>
            <div className="inline-flex items-center gap-1.5">
              <ModelPicker
                value={handoffModelId}
                onChange={setHandoffModelId}
                surfaceKey="chat-handoff"
                availableModelIds={handoffAvailableModelIds}
                filter={handoffForkModelFilter}
                onOpenSignIn={openProviderSignIn}
              />
              <ReasoningEffortPicker
                modelId={handoffModelId}
                reasoningEffort={handoffReasoningEffort}
                onChange={setHandoffReasoningEffort}
              />
            </div>
            <div className="text-[10px] leading-4 text-fg/40">
              Forked history stays with {handoffSourceProviderLabel}; any {handoffSourceProviderLabel} model is fine.
            </div>
            {handoffPermissionControls}
            {handoffNoteField("Optional. Sent to the new chat so it knows what to do next.")}
            <div className="flex items-center justify-end">
              <button
                type="button"
                className="rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] px-3 py-1.5 font-sans text-[11px] font-semibold text-fg/88 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  void handoffSession("fork");
                }}
                disabled={!handoffModelId || handoffBusy || handoffBlocked}
              >
                {handoffBusy ? "Starting…" : "Fork chat"}
              </button>
            </div>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            <div className="text-[11px] leading-5 text-fg/54">
              ADE summarizes this chat and starts a new one from that brief — any model, any lane.
            </div>
            <div className="inline-flex items-center gap-1.5">
              <ModelPicker
                value={handoffModelId}
                onChange={setHandoffModelId}
                surfaceKey="chat-handoff"
                availableModelIds={handoffAvailableModelIds}
                onOpenSignIn={openProviderSignIn}
              />
              <ReasoningEffortPicker
                modelId={handoffModelId}
                reasoningEffort={handoffReasoningEffort}
                onChange={setHandoffReasoningEffort}
              />
            </div>
            {handoffPermissionControls}
            <div className="space-y-1">
              <div className="text-[9px] font-medium uppercase tracking-[0.12em] text-muted-fg/45">Destination lane</div>
              <LaneCombobox
                lanes={handoffLaneOptions}
                value={handoffTargetLaneId || laneId || ""}
                onChange={setHandoffTargetLaneId}
                fullWidth
                aria-label="Destination lane for handoff"
              />
              <div className="text-[10px] leading-4 text-fg/40">Where the new chat starts. Pick another lane or create a fresh one.</div>
            </div>
            {handoffNoteField("Optional. Added to the brief as extra instructions.")}
            <div className="flex items-center justify-end">
              <button
                type="button"
                className="rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_24%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_14%,transparent)] px-3 py-1.5 font-sans text-[11px] font-semibold text-fg/88 transition-colors hover:border-[color:color-mix(in_srgb,var(--chat-accent)_34%,transparent)] disabled:cursor-not-allowed disabled:opacity-40"
                onClick={() => {
                  void handoffSession("brief");
                }}
                disabled={!handoffModelId || handoffBusy || handoffBlocked}
              >
                {handoffBusy ? "Starting…" : "Start brief handoff"}
              </button>
            </div>
          </div>
        )}
        {handoffBlocked ? (
          <div className="mt-3 text-[10px] leading-4 text-fg/40">{handoffButtonTitle}</div>
        ) : null}
      </div>
    </div>
  );
  const handoffTabContent = canShowHandoff ? (
    handoffView === "local" ? handoffLocalView : handoffMenuView
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
      missionsContent={selectedMission ? (
        <div className="h-full min-h-0 overflow-y-auto">
          <MissionControlPanel
            mission={selectedMission}
            onKillWorker={killDroidWorker}
            killingWorkerIds={killingWorkerIds}
          />
        </div>
      ) : undefined}
      proofContent={proofTabContent}
      handoffContent={handoffTabContent}
      sourcesContent={selectedSession?.provider === "codex" ? (
        <ChatSourcesPanel events={selectedEventsForDisplay} />
      ) : undefined}
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
  const terminalPanelContent = chatTerminalVisible ? (
    <ChatTerminalDrawer
      variant="panel"
      open={terminalDrawerOpen}
      onToggle={() => setTerminalDrawerOpen((current) => !current)}
      laneId={laneId}
      chatSessionId={selectedSessionId}
      revealRequest={terminalRevealRequest}
    />
  ) : null;
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
            revealChatTerminal(terminal);
          }}
          onAddContext={addAppControlContext}
        />
      </div>
    </>
  );
  const chatHeaderTrailingActions = (
    <>
      {spawnLineage ? (
        <button
          type="button"
          onClick={() => navigateToSpawnedChat(spawnLineage.parentId, null)}
          className={cn(
            "inline-flex max-w-[220px] items-center gap-1 rounded-full border px-2 py-0.5 font-sans text-[10px] font-medium transition-colors",
            spawnLineage.spawnKind === "peer"
              ? "border-slate-400/18 bg-slate-400/[0.06] text-slate-300/75 hover:border-slate-300/30 hover:text-slate-100/90"
              : "border-violet-400/20 bg-violet-400/[0.06] text-violet-200/80 hover:border-violet-300/32 hover:text-violet-100",
          )}
          title={spawnLineage.parentTitle ? `Parent thread: "${spawnLineage.parentTitle}"` : "View parent thread"}
        >
          <span aria-hidden className="shrink-0">↳</span>
          <span className="min-w-0 truncate">View parent thread</span>
        </button>
      ) : null}
      {chatTerminalVisible && selectedSessionId ? (
        <ClaudeLoginPromptButton
          visible={showClaudeLoginPrompt}
          storageKey={`chat:${selectedSessionId}`}
          laneId={laneId}
          chatSessionId={selectedSessionId}
          onRevealTerminal={revealChatTerminal}
        />
      ) : null}
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
                  selectedScheduledWorkSnapshots.length > 0
                    ? `${selectedScheduledWorkSnapshots.length} scheduled`
                    : null,
                  selectedTodoItems.length > 0
                    ? `${selectedTodoItems.length} task${selectedTodoItems.length === 1 ? "" : "s"}`
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
                ) : selectedScheduledWorkSnapshots.length > 0 ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-sky-400/85 px-0.5 font-mono text-[8px] font-bold text-black">
                    {selectedScheduledWorkSnapshots.length}
                  </span>
                ) : selectedTodoItems.length > 0 ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-violet-400/85 px-0.5 font-mono text-[8px] font-bold text-black">
                    {selectedTodoItems.length}
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
          {headerChips.map((chip) => (
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
        // Ambient settled/snoozed chips — the chat pane otherwise has no
        // lifecycle awareness at all. The composer slot below stays with drift.
        lifecycleSessionId={selectedSessionId ?? null}
        showGitToolbar={showWorkspaceChrome}
        onTogglePrPane={showWorkspaceChrome && laneId ? () => setPrPaneOpen((v) => !v) : undefined}
        prPaneOpen={prPaneOpen}
        trailingActions={chatHeaderTrailingActions}
        onToggleSessionsPane={onToggleSessionsPane}
        sessionsPaneCollapsed={sessionsPaneCollapsed}
        sessionsPaneCount={sessionsPaneCount}
        onToggleToolsPane={onToggleToolsPane}
        toolsPaneOpen={toolsPaneOpen}
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
  const isOrchestratorDraft = forceDraft && orchestratorEnabled && selectedSessionId == null;

  // While Claude is logged out, keep a re-login affordance pinned just above the
  // composer so it stays reachable even when the inline transcript card has
  // scrolled out of view. Reuses the self-contained login pill (styled + own
  // dismiss); it hides itself once the session reconnects. Only shown when the
  // chat header login pill is absent so the two never double up.
  const chatHeaderLoginPromptVisible = !compactShell && !hideSurfaceHeader && chatTerminalVisible && Boolean(selectedSessionId);
  const authStickyBar = showClaudeLoginPrompt && selectedSessionId && !chatHeaderLoginPromptVisible ? (
    <div className="mb-1.5 flex justify-start px-0.5">
      <ClaudeLoginPromptButton
        visible
        storageKey={`composer-auth:${selectedSessionId}`}
        laneId={laneId}
        chatSessionId={selectedSessionId}
        onRevealTerminal={revealChatTerminal}
      />
    </div>
  ) : null;

  const composerElement = (
      <AgentChatComposer
            surfaceMode={surfaceMode}
            // Drives the composer's machine chip. A chat inherits its machine
            // from its lane, so the chip only becomes a picker while the lane is
            // still "auto-create" — that is the one moment no machine is settled
            // yet. Any other value keeps it read-only.
            laneSelectionId={draftLaneSelectorValue}
            layoutVariant={layoutVariant}
            composerMaxHeightPx={composerMaxHeightPx}
            isActive={isTileActive}
            shouldAutofocus={layoutVariant === "grid-tile" ? shouldAutofocusComposer : false}
            sdkSlashCommands={sdkSlashCommands}
            modelId={modelId}
            modelPickerOpenRequestKey={modelPickerOpenRequestKey}
            onModelPickerOpenRequestHandled={handleModelPickerOpenRequestHandled}
            availableModelIds={effectiveAvailableModelIds}
            constrainModelSelection={modelSelectionConstrained}
            modelUnavailableMessage={constrainedModelSelectionError ?? undefined}
            providerAuthStatus={modelPickerProviderAuthStatus}
            onRuntimeCatalogRefreshed={() => {
              setRuntimeCatalogVersion((version) => version + 1);
            }}
            allowCliOnlyModels={workDraftKind === "cli"}
            reasoningEffort={reasoningEffort}
            fastMode={fastMode}
            usageViewModel={selectedUsageViewModel}
            compactionPulse={contextCompactionPulse}
            draft={draft}
            lastSentUserMessage={lastSentUserMessage}
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
            executionModeOptions={launchModeEditable ? executionModeOptions : []}
            modelSelectionLocked={modelSelectionLocked || sessionMutationKind === "model" || turnActive || projectTransitionBlocksChat}
            permissionModeLocked={permissionModeLocked || identitySessionSettingsBusy || projectTransitionBlocksChat}
            hideNativeControls={hideNativeControls}
            hideModelControls={hideModelControls}
            messagePlaceholder={effectiveMessagePlaceholder}
            inputLockMessage={subagentView
              ? `Viewing ${subagentMetadata?.label
              ?? subagentMetadata?.agentNickname
              ?? subagentView.agentType
              ?? subagentViewSnapshot?.description
              ?? subagentView.agentId
              ?? subagentView.taskId}`
              : null}
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
            onOpenAiSettings={openProviderSignIn}
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
                ...(modelSupportsFastMode(snapshot.nextDesc) ? { fastMode } : {}),
                ...nextNativeControlPayload,
              }).then((updatedSession) => {
                applyModelSelectionSnapshot(snapshot);
                patchSessionSummary(selectedSessionId, {
                  provider: updatedSession.provider,
                  model: updatedSession.model,
                  modelId: updatedSession.modelId,
                  reasoningEffort: updatedSession.reasoningEffort ?? null,
                  fastMode: updatedSession.fastMode === true,
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
            onFastModeChange={handleFastModeChange}
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
            chatHasMessages={chatHasMessages}
            pendingSteers={pendingSteers}
            onCancelSteer={(steerId) => {
              if (selectedSessionId) {
                void window.ade.agentChat.cancelSteer({ sessionId: selectedSessionId, steerId });
              }
            }}
            onEditSteer={(steerId, text, queuedAttachments, queuedContextAttachments) => {
              const sessionId = selectedSessionId;
              const draftKey = companionStateKey;
              const draftStorageKey = composerDraftStorageKeyValue;
              if (!sessionId) return;
              const draftSnapshot: ComposerDraftStorageSnapshot = {
                version: 1,
                text: draft,
                modelId,
                reasoningEffort,
                fastMode,
                executionMode,
                controls: {
                  ...currentNativeControls,
                  cursorConfigValues: { ...currentNativeControls.cursorConfigValues },
                },
                attachments: [...attachments],
                contextAttachments: [...contextAttachments],
                iosContextItems: [...iosElementContextItems],
                appControlContextItems: [...appControlContextItems],
                builtInBrowserContextItems: [...builtInBrowserContextItems],
                draftLaunchTargetId,
                updatedAt: new Date().toISOString(),
              };
              void window.ade.agentChat.cancelSteer({ sessionId, steerId, requireQueued: true }).then(() => {
                setPendingSteersBySession((current) => ({
                  ...current,
                  [sessionId]: (current[sessionId] ?? []).filter((entry) => entry.steerId !== steerId),
                }));
                const restoredText = draftSnapshot.text.trim().length
                  ? `${draftSnapshot.text.trimEnd()}\n\n${text}`
                  : text;
                const restoredAttachments = mergeAttachments(draftSnapshot.attachments, queuedAttachments);
                const restoredContextAttachments = mergeChatContextAttachments(
                  draftSnapshot.contextAttachments,
                  queuedContextAttachments,
                );
                draftsPerSessionRef.current.set(draftKey, restoredText);
                writeComposerDraftSnapshot(draftStorageKey, {
                  ...draftSnapshot,
                  text: restoredText,
                  attachments: restoredAttachments,
                  contextAttachments: restoredContextAttachments,
                  updatedAt: new Date().toISOString(),
                });
                clearPromptSuggestionForSession(sessionId);
                if (selectedSessionIdRef.current !== sessionId) return;
                setDraft((current) => {
                  const next = current.trim().length ? `${current.trimEnd()}\n\n${text}` : text;
                  draftsPerSessionRef.current.set(draftKey, next);
                  return next;
                });
                setAttachments((current) => mergeAttachments(current, queuedAttachments));
                setContextAttachments((current) => mergeChatContextAttachments(current, queuedContextAttachments));
              }).catch((error: unknown) => {
                setError(`Couldn't move the queued message back to the composer: ${error instanceof Error ? error.message : String(error)}`);
              });
            }}
            onDispatchSteerInline={selectedSession?.provider === "claude" ? (steerId) => {
              if (selectedSessionId) {
                dispatchSteerSafely({ sessionId: selectedSessionId, steerId, mode: "inline" });
              }
            } : undefined}
            onDispatchSteerInterrupt={selectedSession?.provider === "claude" ? (steerId) => {
              if (selectedSessionId) {
                dispatchSteerSafely({ sessionId: selectedSessionId, steerId, mode: "interrupt" });
              }
            } : undefined}
            onSendSteerNow={selectedSession?.provider === "claude" ? () => {
              void submit("inline");
            } : undefined}
            onSendSteerInterrupt={selectedSession?.provider === "claude" ? () => {
              void submit("interrupt");
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
                  fastMode,
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
              const nextEffort = selectReasoningEffort({ tiers, preferred, modelId: nextModelId });
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
            onParallelSlotFastModeChange={(index, enabled) => {
              patchParallelSlot(index, { fastMode: enabled });
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

  const awayDigestStrip = unattendedWakeTurns.length > 0 ? (
    <div className="flex shrink-0 items-center gap-2 border-t border-amber-200/[0.08] bg-amber-300/[0.055] px-3 py-1.5 font-sans text-[11px] text-amber-100/75">
      <span className="min-w-0 flex-1 truncate">
        While you were away: {unattendedWakeTurns.length} wakeup{unattendedWakeTurns.length === 1 ? "" : "s"}
        {latestUnattendedOutcome ? ` · ${latestUnattendedOutcome}` : ""}
      </span>
      <span className="flex shrink-0 items-center gap-1" aria-label="Jump to scheduled wakeups">
        {unattendedWakeTurns.slice(-3).map((wake, index) => (
          <button
            key={`${wake.scheduleId}:${wake.turnId}`}
            type="button"
            className="rounded px-1 py-0.5 text-amber-200/65 underline-offset-2 hover:bg-amber-200/10 hover:text-amber-100 hover:underline"
            onClick={() => setWakeJumpRequest((current) => ({
              key: `scheduled-wake:${wake.scheduleId}:${wake.turnId}`,
              requestId: (current?.requestId ?? 0) + 1,
            }))}
          >
            {Math.max(1, unattendedWakeTurns.length - Math.min(3, unattendedWakeTurns.length) + index + 1)}
          </button>
        ))}
      </span>
      <button
        type="button"
        aria-label="Dismiss while-you-were-away summary"
        className="grid h-5 w-5 shrink-0 place-items-center rounded text-amber-100/45 hover:bg-amber-200/10 hover:text-amber-100/80"
        onClick={() => setWakeAwayWindow((current) => current ? { ...current, dismissed: true } : current)}
      >
        <X size={11} weight="bold" />
      </button>
    </div>
  ) : null;

  // subagentThreadIdForView / subagentNameForView / subagentPromptForView and the
  // subagentEventsForDisplay useMemo are computed earlier (with the subagent state
  // cluster) so the hook is never called after the `if (!laneId) return` guard.

  // Launch-status banners belong to the new-chat/draft surface only — never
  // above the composer of an already-open chat.
  // Only background launches, auto-create-lane (which starts in lane-creation
  // states), and failures surface a status banner here — a normal foreground
  // send (Enter) to the current lane opens the chat directly, no popup.
  const visibleDraftLaunchJobs = forceDraft
    ? draftLaunchJobs.filter((job) =>
        job.mode === "background"
        || job.status === "failed"
        || job.status === "naming-lane"
        || job.status === "creating-lane")
    : EMPTY_DRAFT_LAUNCH_JOBS;
  const restorableErrorDraftLaunchJob = error
    ? visibleDraftLaunchJobs.find((job) => job.status === "failed" && job.error === error) ?? null
    : null;
  const composerWithTypographyRoot = (
    <div
      data-chat-appearance-root
      style={{ ...chatAppearanceRootStyle, paddingLeft: "var(--chat-pane-reserve-left, 0px)", paddingRight: "var(--chat-pane-reserve-right, 0px)" }}
      className={cn(compactShell ? "min-w-0 w-full" : undefined, "space-y-2")}
    >
      {visibleDraftLaunchJobs.map((job) => {
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
              "flex items-center justify-between gap-3 rounded-lg border px-3 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)]",
              layoutVariant === "grid-tile"
                ? "mx-auto w-full max-w-[var(--chat-column,52rem)]"
                : "mx-3 max-w-[var(--chat-column,52rem)]",
              isFailed && "border-rose-300/20 bg-rose-500/[0.07] text-rose-100/90",
              isReady && "border-emerald-300/18 bg-emerald-500/[0.06] text-emerald-100/85",
              isActiveJob && "border-white/10 bg-white/[0.04] text-fg/70",
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              {isActiveJob ? (
                <CircleNotch size={12} weight="bold" className="shrink-0 animate-spin text-fg/55" aria-hidden />
              ) : null}
              <span className="min-w-0 truncate">
                {isFailed
                  ? (job.error ? `Launch failed: ${job.error}` : "Launch failed.")
                  : isActiveJob
                    ? (isStaleActiveJob ? staleDraftLaunchJobMessage(job) : draftLaunchJobMessage(job))
                    : (
                      <>
                        New Chat Started: <span className="text-fg/85">&ldquo;{draftLaunchPromptSnippet(job)}&rdquo;</span>
                      </>
                    )}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-1">
              {isFailed ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-0.5 text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium text-rose-50/85 transition-colors hover:bg-rose-300/[0.12]"
                  onClick={() => restoreDraftLaunchJob(job)}
                >
                  Restore
                </button>
              ) : null}
              {isActiveJob && job.status === "naming-lane" ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-0.5 text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium text-fg/65 transition-colors hover:bg-white/10 hover:text-fg/85"
                  onClick={() => navigate("/settings?tab=background-jobs")}
                >
                  Settings
                </button>
              ) : null}
              {canOpen ? (
                <button
                  type="button"
                  className="rounded-md px-2 py-0.5 text-[length:calc(var(--chat-font-size)*10.5/14)] font-medium text-emerald-50/90 transition-colors hover:bg-emerald-300/[0.14]"
                  onClick={() => openLaunchedDraftSession({
                    laneId: job.laneId!,
                    laneName: job.laneName!,
                    sessionId: job.sessionId!,
                    draftKind: job.draftKind,
                    jobId: job.id,
                  })}
                >
                  View
                </button>
              ) : null}
              {(!isActiveJob || isStaleActiveJob) ? (
                <button
                  type="button"
                  aria-label={isFailed ? "Dismiss failed launch" : "Dismiss launch status"}
                  className="grid h-5 w-5 place-items-center rounded-md text-fg/45 transition-colors hover:bg-white/10 hover:text-fg/75"
                  onClick={() => dismissDraftLaunchJob(job.id)}
                >
                  <X size={11} weight="bold" aria-hidden />
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
      {authStickyBar}
      {awayDigestStrip}
      <LaneBranchDriftStrip laneId={laneId} />
      {composerElement}
    </div>
  );

  // True when a non-proof companion panel is open. These panels (iOS simulator,
  // App Control) host their own input affordances, so the empty-state layout
  // shrinks the hero and moves the composer below.
  const appPanelOpen = effectiveIosSimulatorOpen || effectiveAppControlOpen;
  const effectiveCursorCloudPaneOpen = cursorCloudPaneOpen && cursorCloudAvailable;
  const terminalRightPaneOpen = chatTerminalVisible && !hasExternalTerminalPane && terminalDrawerOpen && Boolean(selectedSessionId);
  // Orchestration: derive runId / role from the active session. When set, mount
  // the right plan panel and (for "orchestrator-lead") wrap the chat surface in
  // the conic-gradient frame.
  const orchestrationRunId = selectedSession?.orchestrationRunId ?? null;
  const orchestrationRole = activeOrchestrationRole;
  const orchestrationPanelOpen = Boolean(orchestrationRunId);
  const heavyRightPaneOpen = appPanelOpen || effectiveCursorCloudPaneOpen || orchestrationPanelOpen || terminalRightPaneOpen;
  const supportsSplit = layoutVariant !== "grid-tile";
  const chatActionsFloating = chatActionsOpen && supportsSplit && !heavyRightPaneOpen;
  const chatActionsRightPaneOpen = chatActionsOpen && !chatActionsFloating;
  const prFloating = prPaneOpen && Boolean(laneId) && supportsSplit;
  // The chat reserves gutter space and shifts over to make room for each open
  // floating pane (no overlap); the panes themselves fade in/out (opacity) — the
  // two are independent.
  const paneReserve = computePaneReserve(chatAreaWidth, prFloating, chatActionsFloating);
  // When a pane doesn't force the chat to shift (reserve 0), center it within its
  // side margin so all three zones (left pane / chat / right pane) read as
  // centered in their quadrant. When it does shift the chat, pin it to the edge.
  const SIDE_PANE_WIDTH_PX = 264; // 16.5rem
  const centeredPaneOffsetPx = Math.max(
    12,
    Math.round(((chatAreaWidth - CHAT_COLUMN_PX) / 2 - SIDE_PANE_WIDTH_PX) / 2),
  );
  const rightPaneOffsetPx = paneReserve.right === "0px" ? centeredPaneOffsetPx : 12;
  const leftPaneOffsetPx = paneReserve.left === "0px" ? centeredPaneOffsetPx : 12;
  const splitChatColStyle: React.CSSProperties | undefined =
    heavyRightPaneOpen && supportsSplit ? { flexGrow: 100 - rightPaneSplit } : undefined;
  const splitRightPaneStyle: React.CSSProperties | undefined =
    heavyRightPaneOpen && supportsSplit ? { flexGrow: rightPaneSplit, flexBasis: 0 } : undefined;
  const rightPaneDivider = heavyRightPaneOpen && supportsSplit ? (
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

  const SIDE_PANE_FADE = { duration: 0.16, ease: [0.4, 0, 0.2, 1] as const };
  const FLOATING_PANE_CARD_CLASS =
    // `min-h-0` lets the card shrink below its content inside the max-h-capped
    // motion.div, so the inner overflow-auto engages instead of the content
    // clipping at the max-h boundary.
    "ade-floating-side-pane flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-white/[0.07] bg-[color:var(--work-sidebar-bg,#161618)] shadow-[0_20px_60px_-30px_rgba(0,0,0,0.8)]";
  const renderFloatingPane = (content: React.ReactNode) => (
    <motion.div
      key="floating-right-pane"
      className="absolute top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(16.5rem,calc(100%-1.5rem))]"
      style={{ right: `${rightPaneOffsetPx}px` }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={SIDE_PANE_FADE}
    >
      <div className={FLOATING_PANE_CARD_CLASS}>
        {content}
      </div>
    </motion.div>
  );
  const renderFloatingLeftPane = (content: React.ReactNode) => (
    <motion.div
      key="floating-left-pane"
      className="absolute top-3 z-20 flex max-h-[calc(100%-1.5rem)] w-[min(16.5rem,calc(100%-1.5rem))]"
      style={{ left: `${leftPaneOffsetPx}px` }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={SIDE_PANE_FADE}
    >
      {/* The ref goes on the CARD, not the motion.div: the card is what the
          rail has to clear, and the motion.div's opacity animation would
          otherwise be the thing being observed. */}
      <div ref={prPaneInset.ref} className={FLOATING_PANE_CARD_CLASS}>
        {content}
      </div>
    </motion.div>
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
        // Switch the Work tab to the target chat session (a peer worker/validator
        // in the same orchestration lane). TerminalsPage listens for this event.
        try {
          window.dispatchEvent(
            new CustomEvent("ade:work:select-session", {
              detail: { sessionId, laneId: selectedSession?.laneId ?? laneId ?? "" },
            }),
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
        paneReserveLeft={paneReserve.left}
        paneReserveRight={paneReserve.right}
        mode={surfaceMode}
        accentColor={presentation?.accentColor ?? draftAccent}
        contentScale={1}
        chromeTint={chatChromeTint}
        shellGeometry={chatShellGeometry}
        className={compactShell ? cn("border-0 shadow-none rounded-none bg-transparent") : undefined}
        header={compactShell || hideSurfaceHeader ? undefined : shellHeader}
        footer={isEmptyState || appPanelOpen
          ? undefined
          : composerWithTypographyRoot}
        footerClassName={compactShell ? "px-0 pb-0 pt-0" : undefined}
        bodyClassName="flex min-h-0 flex-col overflow-hidden"
      >
        {error ? (
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-red-500/[0.08] bg-red-500/[0.03] px-4 py-2.5 font-sans text-[11px] text-red-300/80">
            <span className="min-w-0 flex-1 break-words">{error}</span>
            {restorableErrorDraftLaunchJob ? (
              <button
                type="button"
                className="shrink-0 rounded-md border border-red-300/15 px-2 py-0.5 font-medium text-red-50/90 transition-colors hover:bg-red-300/[0.12]"
                onClick={() => restoreDraftLaunchJob(restorableErrorDraftLaunchJob, { clearError: true })}
              >
                Restore
              </button>
            ) : null}
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
                  {/* The chat surface — message list and the floating left PR
                      pane are siblings here, so the measured pane height
                      reaches the minimap rail by context, not by a prop through
                      the memoized transcript.

                      Gate the value on the OPEN FLAG, not on the pane element:
                      AnimatePresence keeps the card mounted through its exit
                      fade, so observing the element alone would hold the rail
                      inset for a whole animation after the user already closed
                      the pane. */}
                  <ChatPrPaneInsetContext.Provider value={prFloating && laneId ? prPaneInset.bottomViewportPx : null}>
                  {/* Chat column. `data-chat-sync-pending` is the seam for the
                      catch-up affordance: the transcript below is real but may
                      be behind because the bound runtime could not be reached
                      on the last history read. */}
                  <div
                    data-chat-appearance-root
                    data-chat-sync-pending={selectedSyncPending ? "true" : undefined}
                    style={{ ...chatAppearanceRootStyle, ...splitChatColStyle, paddingLeft: "var(--chat-pane-reserve-left, 0px)", paddingRight: "var(--chat-pane-reserve-right, 0px)" }}
                    className={cn(
                      "flex min-h-0 flex-1 basis-0 flex-col overflow-hidden",
                      layoutVariant === "grid-tile" ? "min-w-0" : "min-w-[280px]",
                    )}
                  >
                    {/* Catch-up hairline. Sits directly under the chat header:
                        the transcript below is real but may be behind because
                        the bound runtime could not be reached on the last
                        history read. Deliberately a static 2px rule that fades
                        — never a continuous animation — and the fade itself is
                        `motion-safe:` so `prefers-reduced-motion` gets an
                        instant swap. It stays mounted at 2px so appearing and
                        disappearing costs no layout shift. */}
                    <div
                      aria-hidden
                      data-chat-sync-hairline={selectedSyncPending ? "true" : undefined}
                      className={cn(
                        "h-[2px] shrink-0 bg-[var(--color-accent)] motion-safe:transition-opacity motion-safe:duration-300",
                        selectedSyncPending ? "opacity-70" : "opacity-0",
                      )}
                    />
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
                                    detail: { sessionId: targetId, laneId: selectedSession.laneId },
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
                    {/* A cold chat should read as "loading", not as an empty
                        void. AgentChatMessageList has no skeleton affordance of
                        its own, so this is a minimal static one (no pulse —
                        continuous animation is not allowed here). */}
                    {selectedChatCold && !subagentView ? (
                      <div
                        aria-hidden
                        data-chat-cold-skeleton
                        className="shrink-0 space-y-3 px-4 pt-4"
                      >
                        {[72, 54, 38].map((widthPct) => (
                          <div
                            key={widthPct}
                            className="h-3 rounded-full bg-white/[0.05]"
                            style={{ width: `${widthPct}%` }}
                          />
                        ))}
                      </div>
                    ) : null}
                    <AgentChatMessageList
                      key={subagentView ? `subagent-${subagentView.taskId}` : renderedSessionId ?? "chat-draft"}
                      events={subagentView ? subagentEventsForDisplay : selectedEventsForDisplay}
                      showStreamingIndicator={subagentView
                        ? subagentTranscriptLoading || subagentViewSnapshot?.status === "running"
                        : turnActive && selectedSession?.status !== "ended"}
                      sessionTurnActive={turnActive}
                      sessionEnded={selectedSession?.status === "ended"}
                      className="min-h-0 border-0"
                      surfaceMode={surfaceMode}
                      surfaceProfile={surfaceProfile}
                      assistantLabel={assistantLabel}
                      hasOlderHistory={Boolean(
                        !subagentView
                        && renderedSessionId
                        && (olderHistoryCursorBySession[renderedSessionId] ?? 0) > 0,
                      )}
                      loadingOlderHistory={Boolean(
                        !subagentView
                        && renderedSessionId
                        && olderHistoryLoadingBySession[renderedSessionId],
                      )}
                      olderHistoryError={
                        !subagentView && renderedSessionId
                          ? olderHistoryErrorBySession[renderedSessionId] ?? null
                          : null
                      }
                      onLoadOlderHistory={!subagentView && renderedSessionId ? loadOlderHistoryForSelectedSession : undefined}
                      onReturnToLatest={!subagentView ? returnSelectedHistoryToLatest : undefined}
                      respondingApprovalIds={respondingApprovalIds}
                      pendingApprovalIds={pendingApprovalIds}
                      laneId={laneId}
                      sessionId={renderedSessionId}
                      onInsertDraft={insertComposerDraft}
                      onRevealChatTerminal={revealChatTerminal}
                      turnDiffSummaries={selectedTurnDiffSummaries}
                      onRewindFiles={selectedSession?.provider === "claude" || selectedSession?.provider === "codex" ? rewindFilesFromMessage : undefined}
                      onCancelQueuedMessage={!subagentView && selectedSessionId ? cancelQueuedMessageFromReceipt : undefined}
                      onApproval={handleListApproval}
                      onCodexRecovery={handleListCodexRecovery}
                      onRunUnprocessedMessage={handleRunUnprocessedMessage}
                      onEditUnprocessedMessage={handleEditUnprocessedMessage}
                      onDismissUnprocessedMessage={handleDismissUnprocessedMessage}
                      onRetryProviderFailure={handleListRetryProviderFailure}
                      onChooseProviderFailureModel={handleListChooseProviderFailureModel}
                      mosaic={subagentView ? undefined : mosaicContext}
                      scrollToRowKeyRequest={subagentView ? null : wakeJumpRequest}
                    />
                    {sessionDelta ? (
                      <div className="flex items-center gap-3 border-t border-white/[0.05] px-4 py-2 font-mono text-[11px]">
                        <span className="text-emerald-400/75">+{sessionDelta.insertions}</span>
                        <span className="text-red-400/75">-{sessionDelta.deletions}</span>
                      </div>
                    ) : null}
                    {appPanelOpen ? (
                      <div className="shrink-0 border-t border-white/[0.06]">
                        {authStickyBar}
                        {awayDigestStrip}
                        <LaneBranchDriftStrip laneId={laneId} />
                        {composerElement}
                      </div>
                    ) : null}
                  </div>

                  {rightPaneDivider}
                  <AnimatePresence initial={false}>
                    {chatActionsFloating
                      ? renderFloatingPane(chatActionsPanelContent)
                      : null}
                  </AnimatePresence>
                  {chatActionsRightPaneOpen
                    ? renderRightPane(chatActionsPanelContent)
                    : null}
                  <AnimatePresence initial={false}>
                    {prFloating && laneId
                      ? renderFloatingLeftPane(
                          <ChatPrPane
                            laneId={laneId}
                            branchName={laneGitBranch}
                            sessionTitle={selectedSession?.title ?? null}
                            delta={prPaneDelta}
                            onClose={() => setPrPaneOpen(false)}
                          />,
                        )
                      : null}
                  </AnimatePresence>
                  {effectiveIosSimulatorOpen ? renderRightPane(iosSimulatorPanelContent) : null}
                  {effectiveAppControlOpen ? renderRightPane(appControlPanelContent) : null}
                  {effectiveCursorCloudPaneOpen ? renderRightPane(cursorCloudPanelContent) : null}
                  {terminalRightPaneOpen && terminalPanelContent ? renderRightPane(terminalPanelContent) : null}
                  {orchestrationPanelOpen && orchestrationPanelContent ? renderRightPane(orchestrationPanelContent) : null}
                  </ChatPrPaneInsetContext.Provider>
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
                      // The optical lift lives in the padding rather than a negative margin on the
                      // column, so `max-h-full` below can cap the column without clipping its top.
                      // 136px = the previous pb-24 (96px) + the removed -mt-10 lift (40px), which
                      // keeps the resting position pixel-identical whenever there is room to spare.
                      appPanelOpen ? "px-3" : "px-6 pb-[136px]",
                    )}>
                      <div className={cn(
                        "flex max-h-full w-full flex-col items-center gap-3 text-center",
                        appPanelOpen ? null : "max-w-[820px]",
                      )}>
                        <motion.div
                          className={cn(
                            // The logo is the only flexible row: in a short window it absorbs the
                            // overflow down to a legible floor, so the composer stays visible far
                            // longer than it did when the whole column was rigid.
                            "relative flex min-h-[56px] w-full min-w-0 shrink items-center justify-center",
                            appPanelOpen ? "max-w-[360px]" : "max-w-[520px]",
                          )}
                          style={{ aspectRatio: "560 / 300" }}
                          exit={{ opacity: 0, scale: 0.8, transition: { duration: 0.3, ease: "easeOut" } }}
                        >
                          <img
                            src="./logo.png"
                            alt="ADE"
                            className="relative z-10 h-auto max-h-full w-full max-w-full object-contain"
                          />
                        </motion.div>

                        <h2 className="shrink-0 font-sans text-[18px] font-semibold tracking-tight text-fg/80">
                          {isOrchestratorDraft ? "Orchestrate a swarm of agents" : "Start a new conversation"}
                        </h2>

                        {/* Lane selector pill */}
                        {showWorkspaceChrome && draftLaneSelectorLanes.length > 0 && onLaneChange ? (
                          <motion.div
                            className="flex shrink-0 justify-center"
                            exit={{ opacity: 0, transition: { duration: 0.15 } }}
                          >
                            <div className="flex flex-col items-center gap-2">
                              <LaneCombobox
                                lanes={draftLaneSelectorLanes}
                                value={draftLaneSelectorValue}
                                onChange={handleDraftLaneSelectionChange}
                                variant="pill"
                                aria-label="Select lane"
                              />
                              {onOpenShellSession || onImportedSession ? (
                                <div className="flex flex-wrap justify-center gap-2">
                                  {onOpenShellSession ? (
                                    <SmartTooltip
                                      content={{
                                        label: "Open shell",
                                        description: draftLaunchTargetIsAutoCreate
                                          ? "Select a lane first — a shell needs a lane folder."
                                          : "Launch a new shell in the selected lane.",
                                      }}
                                    >
                                      <button
                                        type="button"
                                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3.5 text-[11px] font-medium text-muted-fg/80 transition-colors hover:bg-white/[0.08] hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                                        disabled={!laneId || draftLaunchTargetIsAutoCreate || shellLaunchBusy}
                                        aria-label="Open shell in selected lane"
                                        onClick={() => void launchShellForDraftLane()}
                                      >
                                        <Terminal size={13} weight="regular" />
                                        Shell
                                      </button>
                                    </SmartTooltip>
                                  ) : null}
                                  {onImportedSession ? (
                                    <SmartTooltip
                                      content={{
                                        label: "Import session",
                                        description: draftLaunchTargetIsAutoCreate
                                          ? "Select a lane first — imports need a lane folder."
                                          : "Continue an external Claude, Codex, Cursor, Droid, or OpenCode session here.",
                                      }}
                                    >
                                      <button
                                        type="button"
                                        className="inline-flex h-8 items-center justify-center gap-1.5 rounded-full border border-white/[0.08] bg-white/[0.04] px-3.5 text-[11px] font-medium text-muted-fg/80 transition-colors hover:bg-white/[0.08] hover:text-fg disabled:cursor-not-allowed disabled:opacity-45"
                                        disabled={!laneId || draftLaunchTargetIsAutoCreate}
                                        aria-label="Import an external CLI session"
                                        onClick={() => setImportBrowserOpen(true)}
                                      >
                                        <DownloadSimple size={13} weight="regular" />
                                        Import session
                                      </button>
                                    </SmartTooltip>
                                  ) : null}
                                </div>
                              ) : null}
                            </div>
                          </motion.div>
                        ) : showWorkspaceChrome && laneDisplayLabel ? (
                          <motion.div
                            className="flex shrink-0 items-center gap-2 rounded-full px-4 py-1.5"
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
                          <div className="w-full shrink-0">
                            {composerWithTypographyRoot}
                          </div>
                        ) : null}

                        {isWorkDraftComposer && !appPanelOpen ? (
                          <motion.div
                            className="flex w-full shrink-0 justify-center"
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 6 }}
                            transition={{ duration: 0.28, ease: "easeOut" }}
                          >
                            <WorkActivityModule />
                          </motion.div>
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
      {selectedSessionId && (selectedSession?.laneId ?? laneId) ? (
        <CrossMachineHandoffModal
          open={crossMachineHandoffOpen}
          sourceSessionId={selectedSessionId}
          sourceLaneId={(selectedSession?.laneId ?? laneId)!}
          sourceProvider={selectedSession?.provider}
          target={crossMachineHandoffTarget}
          modelId={remoteHandoffModelId}
          onModelChange={setRemoteHandoffModelId}
          availableModelIds={handoffAvailableModelIds}
          forkAvailableModelIds={handoffForkAvailableModelIds}
          reasoningEffort={handoffReasoningEffort}
          onReasoningEffortChange={setHandoffReasoningEffort}
          fastMode={handoffFastMode}
          onFastModeChange={setHandoffFastMode}
          nativeControls={handoffNativeControlState}
          onNativeControlsChange={applyHandoffNativeControls}
          onOpenSignIn={openProviderSignIn}
          turnActive={turnActive}
          awaitingInput={selectedSessionAwaitingInput}
          onStopTurn={interrupt}
          onClose={() => setCrossMachineHandoffOpen(false)}
          onFinished={() => {
            setHandoffNote("");
            void refreshSessions({ force: true }).catch(() => undefined);
          }}
        />
      ) : null}
      <ConfirmDialog state={archiveConfirm.state} onClose={archiveConfirm.close} />
      {onImportedSession && laneId ? (
        <ImportSessionBrowser
          open={importBrowserOpen}
          onOpenChange={setImportBrowserOpen}
          laneId={laneId}
          laneName={
            availableLanes?.find((lane) => lane.id === laneId)?.name ?? laneDisplayLabel ?? laneId
          }
          lanes={availableLanes ?? lanes}
          onImported={onImportedSession}
          onOpenExisting={onOpenExistingImportedSession}
        />
      ) : null}
    </>
  );
}
