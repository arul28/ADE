import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion } from "motion/react";
import { Cube, Desktop, DeviceMobile, Plus } from "@phosphor-icons/react";
import {
  inferAttachmentType,
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
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AiProviderConnectionStatus,
  type AiRuntimeConnectionStatus,
  type AgentChatSession,
  type AgentChatOpenCodePermissionMode,
  type AgentChatPermissionMode,
  type AgentChatParallelLaunchState,
  type AgentChatSessionProfile,
  type ChatSurfaceChip,
  type ChatSurfaceProfile,
  type ChatSurfacePresentation,
  type AgentChatSessionSummary,
  type BuiltInBrowserContextItem,
  type ComputerUseOwnerSnapshot,
  type AppControlContextItem,
  type IosElementContextItem,
  type IosSimulatorDrawerMode,
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
  resolveProviderGroupForModel,
  resolveModelDescriptorForProvider,
  type LocalProviderFamily,
  type ModelDescriptor,
} from "../../../shared/modelRegistry";
import { filterChatModelIdsForSession } from "../../../shared/chatModelSwitching";
import { CURSOR_AVAILABLE_MODE_IDS } from "../../../shared/cursorModes";
import { cn } from "../ui/cn";
import { AgentChatComposer, type ParallelComposerControlSlot } from "./AgentChatComposer";
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
import { SmartTooltip } from "../ui/SmartTooltip";
import { ChatSurfaceShell } from "./ChatSurfaceShell";
import { chatChipToneClass, providerChatAccent } from "./chatSurfaceTheme";
import { ChatComputerUsePanel } from "./ChatComputerUsePanel";
import { ChatIosSimulatorPanel } from "./ChatIosSimulatorPanel";
import { ChatAppControlPanel } from "./ChatAppControlPanel";
import { ChatSubagentsPanel } from "./ChatSubagentsPanel";
import { ChatTasksPanel } from "./ChatTasksPanel";
import { ChatFileChangesPanel } from "./ChatFileChangesPanel";
import { ChatCursorCloudPanel, type ChatCursorCloudPanelHandle } from "./ChatCursorCloudPanel";
import { CursorCloudInlineLaunch, type CursorCloudInlineLaunchHandle } from "./CursorCloudInlineLaunch";
import { ChatGitToolbar } from "./ChatGitToolbar";
import { ChatTerminalDrawer, ChatTerminalToggle } from "./ChatTerminalDrawer";
import { deriveChatSubagentSnapshots, deriveTodoItems, deriveTurnDiffSummaries } from "./chatExecutionSummary";
import { derivePendingInputRequests, type DerivedPendingInput } from "./pendingInput";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { ConfirmDialog, useConfirmDialog } from "../shared/InlineDialogs";
import { useClickOutside } from "../../hooks/useClickOutside";
import { useAppStore } from "../../state/appStore";
import { buildChatAppearanceRootStyle } from "./chatAppearance";
import { LaneAccentDot } from "../lanes/LaneAccentDot";
import { LaneCombobox } from "../terminals/LaneCombobox";
import { ClaudeCacheTtlBadge } from "../shared/ClaudeCacheTtlBadge";
import { shouldShowClaudeCacheTtl } from "../../lib/claudeCacheTtl";
import { getAgentChatModelsCached, getAiStatusCached, peekAiStatusCached } from "../../lib/aiDiscoveryCache";
import { invalidateSessionListCache } from "../../lib/sessionListCache";

import { playAgentTurnCompletionSound } from "../../lib/agentTurnCompletionSound";

const LAST_MODEL_ID_KEY = "ade.chat.lastModelId";
const LAST_REASONING_KEY_PREFIX = "ade.chat.lastReasoningEffort";
export const DEFAULT_PARALLEL_ATTACHMENT_REQUEST = "Please review the attached files.";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.trim().length ? value.trim() : null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function frameFromUnknown(value: unknown): BuiltInBrowserContextItem["frame"] | null {
  const record = asRecord(value);
  if (!record) return null;
  const x = numberOrNull(record.x);
  const y = numberOrNull(record.y);
  const width = numberOrNull(record.width);
  const height = numberOrNull(record.height);
  if (x == null || y == null || width == null || height == null) return null;
  return { x, y, width, height };
}

function iosContextLabel(item: IosElementContextItem): string {
  const metadata = item.metadata ?? {};
  const label = typeof metadata.label === "string" && metadata.label.trim()
    ? metadata.label.trim()
    : null;
  const role = typeof metadata.role === "string" && metadata.role.trim()
    ? metadata.role.trim()
    : null;
  return label ?? item.componentId ?? role ?? "iOS simulator element";
}

function iosContextSurface(item: IosElementContextItem): "simulator" | "xcode-preview" {
  const source = typeof item.metadata?.screenElementSource === "string" ? item.metadata.screenElementSource : "";
  return item.metadata?.contextSurface === "xcode-preview" || source.startsWith("xcode-preview")
    ? "xcode-preview"
    : "simulator";
}

function formatIosElementContextChipsForDisplay(items: IosElementContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${iosContextLabel(item)}\``).join(" ");
}

function formatIosElementContextForPrompt(items: IosElementContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const sourceConfidence = typeof metadata.sourceConfidence === "string"
      ? metadata.sourceConfidence
      : item.sourceFile ? "exact" : "none";
    let source: string;
    if (item.sourceFile) {
      source = `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`;
    } else if (sourceConfidence === "candidate") {
      source = "no exact source; ranked candidates below";
    } else {
      source = "no source match";
    }
    const frame = item.frame
      ? `x=${item.frame.x}, y=${item.frame.y}, w=${item.frame.width}, h=${item.frame.height}`
      : "unknown frame";
    const attachmentPath = getIosContextAttachmentPath(item);
    const sourceCandidates = asRecordArray(metadata.sourceCandidates ?? metadata.sourceMatches)
      .slice(0, 3)
      .map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceLine: candidate.sourceLine,
        confidence: candidate.confidence,
        reason: candidate.reason,
        snippet: typeof candidate.snippet === "string" ? candidate.snippet : undefined,
      }));
    const nearbyElements = asRecordArray(metadata.nearbyElements)
      .slice(0, 8)
      .map((element) => ({
        label: element.label,
        value: element.value,
        role: element.role,
        elementType: element.elementType,
        identifier: element.identifier,
        componentId: element.componentId,
        source: element.source,
        relation: element.relation,
        screenshotFrame: element.screenshotFrame,
      }));
    const packet = {
      contextId: item.id,
      visualAttachmentPath: attachmentPath,
      selectedAt: item.selectedAt,
      selectedElement: metadata.selectedElement ?? {
        componentId: item.componentId,
        accessibilityIdentifier: item.accessibilityIdentifier ?? null,
        label: metadata.label,
        value: metadata.value,
        role: metadata.role,
        elementType: metadata.elementType,
        screenshotFrame: frame,
      },
      screen: metadata.screen,
      sourceConfidence,
      exactSource: item.sourceFile ? {
        sourceFile: item.sourceFile,
        sourceLine: item.sourceLine,
        snippet: typeof metadata.sourceSnippet === "string" ? metadata.sourceSnippet : null,
      } : null,
      sourceCandidates,
      nearbyElements,
    };
    const snippet = typeof metadata.sourceSnippet === "string" && metadata.sourceSnippet.trim().length
      ? `\nExact source snippet:\n${metadata.sourceSnippet}`
      : "";
    return `${index + 1}. ${iosContextLabel(item)} (${source}, frame=${frame})\nPacket:\n${JSON.stringify(packet, null, 2)}${snippet}`;
  });
  return [
    "iOS visual inspect context attached by the user.",
    "Each packet came from the user clicking a UI element in the real iOS Simulator, dragging a simulator screenshot region, or dragging a capture area in an Xcode SwiftUI preview. Image attachments/crops are visual evidence for the same packet and use the same screenshot coordinate space.",
    "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked best guesses, not proof; prefer nearbyElements and the screenshot when the source is missing or only candidate quality.",
    "When the packet surface is xcode-preview, treat it as fast fixture/mock-data feedback rather than live app state. Keep SwiftUI changes previewable with nearby #Preview definitions and deterministic mock fixtures.",
    ...rows,
    "",
  ].join("\n");
}

function getIosContextAttachmentPath(item: IosElementContextItem): string | null {
  const value = item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

function createIosContextInstanceId(item: IosElementContextItem): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${item.id}::${suffix}`;
}

function appControlContextLabel(item: AppControlContextItem): string {
  const metadata = item.metadata ?? {};
  for (const value of [metadata.label, metadata.value, item.componentId, metadata.role, metadata.tagName]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "App Control element";
}

function formatAppControlContextChipsForDisplay(items: AppControlContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${appControlContextLabel(item)}\``).join(" ");
}

function getAppControlContextAttachmentPath(item: AppControlContextItem): string | null {
  const value = item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

function createAppControlContextInstanceId(item: AppControlContextItem): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${item.id}::${suffix}`;
}

function formatAppControlContextForPrompt(items: AppControlContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const sourceConfidence = typeof metadata.sourceConfidence === "string"
      ? metadata.sourceConfidence
      : item.sourceFile ? "exact" : "none";
    const frame = item.frame
      ? `x=${item.frame.x}, y=${item.frame.y}, w=${item.frame.width}, h=${item.frame.height}`
      : "unknown frame";
    const attachmentPath = getAppControlContextAttachmentPath(item);
    const sourceCandidates = asRecordArray(metadata.sourceCandidates)
      .slice(0, 5)
      .map((candidate) => ({
        sourceFile: candidate.sourceFile,
        sourceLine: candidate.sourceLine,
        confidence: candidate.confidence,
        reason: candidate.reason,
        snippet: typeof candidate.snippet === "string" ? candidate.snippet : undefined,
      }));
    const nearbyElements = asRecordArray(metadata.nearbyElements).slice(0, 8);
    const packet = {
      contextId: item.id,
      appKind: item.appKind,
      provider: item.provider,
      visualAttachmentPath: attachmentPath,
      selectedAt: item.selectedAt,
      selectedElement: metadata.selectedElement ?? {
        componentId: item.componentId,
        label: metadata.label,
        value: metadata.value,
        role: metadata.role,
        tagName: metadata.tagName,
        selector: metadata.selector,
        testId: metadata.testId,
        screenshotFrame: frame,
      },
      screen: metadata.screen,
      url: metadata.url,
      title: metadata.title,
      sourceConfidence,
      exactSource: item.sourceFile ? {
        sourceFile: item.sourceFile,
        sourceLine: item.sourceLine,
        snippet: typeof metadata.sourceSnippet === "string" ? metadata.sourceSnippet : null,
      } : null,
      sourceCandidates,
      nearbyElements,
    };
    const source = item.sourceFile
      ? `${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`
      : sourceConfidence === "candidate" ? "no exact source; ranked candidates below" : "no source match";
    const snippet = typeof metadata.sourceSnippet === "string" && metadata.sourceSnippet.trim().length
      ? `\nBest source snippet:\n${metadata.sourceSnippet}`
      : "";
    return `${index + 1}. ${appControlContextLabel(item)} (${source}, frame=${frame})\nPacket:\n${JSON.stringify(packet, null, 2)}${snippet}`;
  });
  return [
    "App Control visual inspect context attached by the user.",
    "Each packet came from a developer-owned app session, usually Electron launched or connected through ADE CLI with a local CDP port. Image attachments/crops are visual evidence for the same packet and use screenshot pixel coordinates.",
    "Use exactSource when sourceConfidence is exact. Treat sourceCandidates as ranked guesses from DOM text/test ids/selectors and source search, not proof. Prefer the screenshot, DOM selector, nearbyElements, console/browser context, and exact source when available.",
    ...rows,
    "",
  ].join("\n");
}

function normalizeBuiltInBrowserContextItem(value: unknown): BuiltInBrowserContextItem | null {
  const record = asRecord(value);
  if (!record) return null;
  const metadata = asRecord(record.metadata) ?? {};
  const pixelFrameCandidate = frameFromUnknown(record.pixelFrame);
  const frame = frameFromUnknown(record.frame) ?? pixelFrameCandidate ?? frameFromUnknown(record.bounds) ?? {
    x: 0,
    y: 0,
    width: 0,
    height: 0,
  };
  const pixelFrame = pixelFrameCandidate ?? frame;
  const componentId = stringOrNull(record.componentId)
    ?? stringOrNull(metadata.selector)
    ?? stringOrNull(metadata.testId)
    ?? stringOrNull(metadata.tagName)
    ?? "browser-element";
  const kind = stringOrNull(record.kind) === "built_in_browser_capture" ? "built_in_browser_capture" : "built_in_browser_element";
  return {
    kind,
    id: stringOrNull(record.id) ?? `built-in-browser:${Date.now().toString(36)}`,
    provider: "cdp",
    componentId,
    url: stringOrNull(record.url),
    title: stringOrNull(record.title),
    sourceFile: stringOrNull(record.sourceFile),
    sourceLine: numberOrNull(record.sourceLine),
    frame,
    pixelFrame,
    metadata,
    screenshotDataUrl: stringOrNull(record.screenshotDataUrl) ?? stringOrNull(record.dataUrl),
    selectedAt: stringOrNull(record.selectedAt) ?? new Date().toISOString(),
  };
}

function builtInBrowserContextLabel(item: BuiltInBrowserContextItem): string {
  const metadata = item.metadata ?? {};
  if (item.kind === "built_in_browser_capture") {
    const selectedElement = asRecord(metadata.selectedElement);
    const selectedLabel = stringOrNull(selectedElement?.label);
    return selectedLabel ? `Browser capture: ${selectedLabel}` : "Browser screenshot capture";
  }
  for (const value of [
    metadata.label,
    metadata.text,
    metadata.value,
    item.componentId,
    metadata.selector,
    metadata.role,
    metadata.tagName,
  ]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Browser element";
}

function formatBuiltInBrowserContextChipsForDisplay(items: BuiltInBrowserContextItem[]): string {
  if (!items.length) return "";
  return items.map((item) => `\`${builtInBrowserContextLabel(item)}\``).join(" ");
}

function getBuiltInBrowserContextAttachmentPath(item: BuiltInBrowserContextItem): string | null {
  const value = item.metadata?.attachmentPath;
  return typeof value === "string" && value.length ? value : null;
}

function createBuiltInBrowserContextInstanceId(item: BuiltInBrowserContextItem): string {
  const suffix = typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  return `${item.id}::${suffix}`;
}

function stripDataUrlPrefix(dataUrl: string): string {
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

function formatBuiltInBrowserContextForPrompt(items: BuiltInBrowserContextItem[]): string {
  if (!items.length) return "";
  const rows = items.map((item, index) => {
    const metadata = item.metadata ?? {};
    const frame = item.frame
      ? `x=${item.frame.x}, y=${item.frame.y}, w=${item.frame.width}, h=${item.frame.height}`
      : "unknown frame";
    const attachmentPath = getBuiltInBrowserContextAttachmentPath(item);
    const packet = {
      contextId: item.id,
      provider: item.provider,
      visualAttachmentPath: attachmentPath,
      selectedAt: item.selectedAt,
      url: item.url ?? metadata.url ?? null,
      title: item.title ?? metadata.title ?? null,
      selectedElement: metadata.selectedElement ?? {
        componentId: item.componentId,
        label: metadata.label,
        value: metadata.value,
        role: metadata.role,
        tagName: metadata.tagName,
        selector: metadata.selector,
        testId: metadata.testId,
        screenshotFrame: frame,
      },
      attributes: metadata.attributes,
      href: metadata.href,
      inputType: metadata.inputType,
      disabled: metadata.disabled,
      checked: metadata.checked,
      viewport: metadata.viewport,
      scroll: metadata.scroll,
      captureFrame: metadata.captureFrame,
      crop: metadata.crop,
      centerPoint: metadata.centerPoint,
      source: metadata.source,
      sourceConfidence: metadata.sourceConfidence,
      selectionExplanation: metadata.selectionExplanation,
    };
    return `${index + 1}. ${builtInBrowserContextLabel(item)} (global browser, frame=${frame})\nPacket:\n${JSON.stringify(packet, null, 2)}`;
  });
  return [
    "Built-in browser visual and DOM context attached by the user.",
    "Each packet came from ADE's global built-in browser, which is not lane-scoped. Image attachments/crops are visual evidence for the same page area and use browser viewport coordinates.",
    "Use selectors, ARIA labels, attributes, text, URL/title, and the screenshot together. Do not assume the selected page belongs to the current lane unless the URL or user message says so.",
    ...rows,
    "",
  ].join("\n");
}

const LEGACY_PROVIDER_KEY = "ade.chat.lastProvider";
const LEGACY_MODEL_KEY_PREFIX = "ade.chat.lastModel";

const COMPUTER_USE_SNAPSHOT_COOLDOWN_MS = 750;
const CHAT_HISTORY_READ_MAX_BYTES = 2_000_000;
const MAX_RETAINED_CHAT_SESSION_HISTORIES = 6;
const MAX_SELECTED_CHAT_SESSION_EVENTS = 20_000;
const MAX_BACKGROUND_CHAT_SESSION_EVENTS = 1_000;

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
        helper: "Tell Droid to use available delegation or mission-style tools for independent subtasks, then reconcile the result.",
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

type NativeControlState = {
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  cursorModeId: string | null;
  cursorConfigValues: Record<string, AgentChatCursorConfigValue>;
};

type ParallelModelRowState = NativeControlState & {
  modelId: string;
  reasoningEffort: string | null;
  executionMode: AgentChatExecutionMode;
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
  const { modelId: _, reasoningEffort: _re, executionMode: _em, ...native } = slot;
  return native;
}

function cloneParallelSlotFromComposer(args: {
  native: NativeControlState;
  modelId: string;
  reasoningEffort: string | null;
  executionMode: AgentChatExecutionMode;
}): ParallelModelRowState {
  return {
    ...args.native,
    cursorConfigValues: { ...args.native.cursorConfigValues },
    modelId: args.modelId,
    reasoningEffort: args.reasoningEffort,
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
    } else if (
      (controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "on-failure" || controls.codexApprovalPolicy === "untrusted")
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

type HandoffCodexPreset = "default" | "plan" | "full-auto" | "config-toml" | "custom";

function resolveHandoffCodexPreset(controls: {
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
}): HandoffCodexPreset {
  if (controls.codexConfigSource === "config-toml") return "config-toml";
  if ((controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "on-failure" || controls.codexApprovalPolicy === "untrusted") && controls.codexSandbox === "workspace-write") return "default";
  if ((controls.codexApprovalPolicy === "on-request" || controls.codexApprovalPolicy === "untrusted") && controls.codexSandbox === "read-only") return "plan";
  if (controls.codexApprovalPolicy === "never" && controls.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

function handoffApplyCodexPreset(
  preset: "default" | "plan" | "full-auto" | "config-toml",
  fallbacks: { cap: AgentChatCodexApprovalPolicy; sandbox: AgentChatCodexSandbox },
): Pick<NativeControlState, "codexApprovalPolicy" | "codexSandbox" | "codexConfigSource"> {
  if (preset === "default") {
    return {
      codexApprovalPolicy: "on-request",
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
  { value: "plan", label: "Plan" },
  { value: "bypassPermissions", label: "Bypass" },
];

const HANDOFF_OPENCODE_MODES: Array<{ value: AgentChatOpenCodePermissionMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
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

export function mergeChatHistorySnapshot(
  parsed: AgentChatEventEnvelope[],
  existing: AgentChatEventEnvelope[],
): AgentChatEventEnvelope[] {
  if (!existing.length) return parsed;
  if (!parsed.length) return existing;

  const parsedKeys = new Set(parsed.map(chatEventDedupKey));
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
  return tail.length ? [...parsed, ...tail] : parsed;
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

function resolveCliRegistryModelId(provider: "codex" | "claude" | "cursor" | "droid", value: string | null | undefined): string | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (!normalized.length) return null;
  if (provider === "cursor") {
    const fullId = normalized.startsWith("cursor/") ? normalized : `cursor/${normalized}`;
    const dynamic = getModelById(fullId) ?? resolveModelDescriptorForProvider(normalized.replace(/^cursor\//, ""), "cursor");
    if (dynamic && dynamic.family === "cursor" && dynamic.isCliWrapped) return dynamic.id;
    return null;
  }
  if (provider === "droid") {
    const fullId = normalized.startsWith("droid/") ? normalized : `droid/${normalized}`;
    const dynamic = getModelById(fullId) ?? resolveModelDescriptorForProvider(normalized.replace(/^droid\//, ""), "droid");
    if (dynamic && dynamic.family === "factory" && dynamic.isCliWrapped) return dynamic.id;
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
}): { sendText: string; displayText: string } {
  const trimmed = args.text.trim();
  let displayText = "";
  if (trimmed.length) {
    displayText = trimmed;
  } else if (args.attachmentCount > 0) {
    displayText = DEFAULT_PARALLEL_ATTACHMENT_REQUEST;
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

function completionBadgeClass(status: NonNullable<AgentChatSessionSummary["completion"]>["status"]): string {
  switch (status) {
    case "completed": return "border-emerald-400/20 bg-emerald-400/[0.08] text-emerald-300";
    case "blocked": return "border-red-400/20 bg-red-400/[0.08] text-red-300";
    default: return "border-amber-400/20 bg-amber-400/[0.08] text-amber-300";
  }
}

type ChatCompanionUiState = {
  proofDrawerOpen: boolean;
  iosSimulatorOpen: boolean;
  appControlOpen: boolean;
  terminalDrawerOpen: boolean;
};

const DEFAULT_CHAT_COMPANION_UI_STATE: ChatCompanionUiState = {
  proofDrawerOpen: false,
  iosSimulatorOpen: false,
  appControlOpen: false,
  terminalDrawerOpen: false,
};

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
      const parsed = JSON.parse(raw) as Partial<ChatCompanionUiState>;
      const state = {
        proofDrawerOpen: parsed.proofDrawerOpen === true,
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
  layoutVariant = "standard",
  isTileActive = true,
  isTileVisible = isTileActive,
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
  layoutVariant?: "standard" | "grid-tile";
  isTileActive?: boolean;
  /** Visible grid tiles hydrate transcripts even when they are not the focused tile. */
  isTileVisible?: boolean;
  shouldAutofocusComposer?: boolean;
  onSessionCreated?: (session: AgentChatSession) => void | Promise<void>;
  /** Available lanes for the lane selector in empty state (full `LaneSummary` includes `branchRef` for branch sublines in the menu). */
  availableLanes?: Array<{ id: string; name: string; color?: string | null; branchRef?: string | null }>;
  /** Callback when lane selection changes in empty state */
  onLaneChange?: (laneId: string) => void;
}) {
  const projectRoot = useAppStore((s) => s.project?.rootPath ?? null);
  const agentTurnCompletionSound = useAppStore((s) => s.agentTurnCompletionSound);
  const agentTurnCompletionSoundVolume = useAppStore((s) => s.agentTurnCompletionSoundVolume);
  const agentTurnCompletionSoundQuietWhenFocused = useAppStore((s) => s.agentTurnCompletionSoundQuietWhenFocused);
  const chatFontSizePx = useAppStore((s) => s.chatFontSizePx);
  const chatTranscriptDensity = useAppStore((s) => s.chatTranscriptDensity);
  const chatChromeTint = useAppStore((s) => s.chatChromeTint);
  const chatShellGeometry = useAppStore((s) => s.chatShellGeometry);
  const chatAppearanceRootStyle = useMemo(
    () => buildChatAppearanceRootStyle({ chatFontSizePx, transcriptDensity: chatTranscriptDensity }),
    [chatFontSizePx, chatTranscriptDensity],
  );
  const lanes = useAppStore((s) => s.lanes);
  const navigate = useNavigate();
  const openAiProvidersSettings = useCallback(() => {
    navigate("/settings?tab=ai#ai-providers");
  }, [navigate]);
  const setWorkViewState = useAppStore((s) => s.setWorkViewState);
  const setLaneWorkViewState = useAppStore((s) => s.setLaneWorkViewState);
  const refreshLanesStore = useAppStore((s) => s.refreshLanes);
  const laneAccentColor = useAppStore((s) => {
    if (!laneId) return null;
    return s.lanes.find((l) => l.id === laneId)?.color ?? null;
  });
  const lockedSingleSessionMode = Boolean(lockSessionId && hideSessionTabs);
  const forceDraft = forceDraftMode || forceNewSession;
  const preferDraftStart = !lockSessionId && !initialSessionId && !forceNewSession;
  const surfaceProfile: ChatSurfaceProfile = presentation?.profile ?? "standard";
  const isPersistentIdentitySurface = surfaceProfile === "persistent_identity";
  const showWorkspaceChrome = !hideWorkspaceChrome;
  const modelSwitchPolicy = presentation?.modelSwitchPolicy ?? "same-family-after-launch";
  const initialNativeControls = useMemo(() => defaultNativeControls(surfaceProfile), [surfaceProfile]);
  const initialCompanionStateKey = lockSessionId ?? initialSessionId ?? (laneId ? `draft:${laneId}` : "draft");
  const [sessions, setSessions] = useState<AgentChatSessionSummary[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<AgentChatSessionSummary[]>([]);
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
  const [proofDrawerOpen, setProofDrawerOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).proofDrawerOpen,
  );
  const [iosSimulatorOpen, setIosSimulatorOpen] = useState(
    () => readChatCompanionUiState(initialCompanionStateKey).iosSimulatorOpen,
  );
  const [iosSimulatorDrawerModeRequest, setIosSimulatorDrawerModeRequest] = useState<{ mode: IosSimulatorDrawerMode; nonce: number } | null>(null);
  const [iosSimulatorAvailable, setIosSimulatorAvailable] = useState(isLikelyMacRenderer);
  const [cursorCloudPaneOpen, setCursorCloudPaneOpen] = useState(false);
  const [cursorCloudLaunchModeOpen, setCursorCloudLaunchModeOpen] = useState(false);
  const cursorCloudPanelRef = useRef<ChatCursorCloudPanelHandle | null>(null);
  const cursorCloudInlineLaunchRef = useRef<CursorCloudInlineLaunchHandle | null>(null);
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
  const companionHydrationKeyRef = useRef<string | null>(initialCompanionStateKey);
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
  const [handoffReasoningEffort, setHandoffReasoningEffort] = useState<string | null>(null);
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
  const [parallelLaunchBusy, setParallelLaunchBusy] = useState(false);
  const [parallelLaunchStatus, setParallelLaunchStatus] = useState<string | null>(null);
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
  const pendingNativeControlUpdateRef = useRef<{
    sessionId: string;
    updateId: number;
    promise: Promise<void>;
  } | null>(null);
  const nativeControlUpdateCounterRef = useRef(0);
  const reasoningEffortUpdateCounterRef = useRef(0);
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
  const recoveredParallelLaunchKeyRef = useRef<string | null>(null);
  const selectedSession = useMemo(
    () => (selectedSessionId ? sessions.find((session) => session.sessionId === selectedSessionId) ?? null : null),
    [sessions, selectedSessionId]
  );
  const effectiveIosSimulatorOpen = !hideLaneToolDrawers && iosSimulatorOpen;
  const effectiveAppControlOpen = !hideLaneToolDrawers && appControlOpen;
  const laneToolsVisible = Boolean(showWorkspaceChrome && !hideLaneToolDrawers && laneId);
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
  }, []);

  useEffect(() => {
    companionHydrationKeyRef.current = companionStateKey;
    const saved = readChatCompanionUiState(companionStateKey);
    setProofDrawerOpen(saved.proofDrawerOpen);
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
      proofDrawerOpen,
      iosSimulatorOpen,
      appControlOpen,
      terminalDrawerOpen,
    });
  }, [appControlOpen, companionStateKey, iosSimulatorOpen, proofDrawerOpen, terminalDrawerOpen]);

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
    draftsPerSessionRef.current.set(selectedSessionId, value);
    if (value.length > 0) setPromptSuggestion(null);
  }, [selectedSessionId]);
  const insertComposerDraft = useCallback((value: string) => {
    setDraft((current) => {
      const next = current.trim().length ? `${current.trimEnd()}\n\n${value}` : value;
      draftsPerSessionRef.current.set(selectedSessionId, next);
      return next;
    });
    setPromptSuggestion(null);
  }, [selectedSessionId]);

  const iosSimulatorProjectRoot = useMemo(() => {
    const scopedLaneId = selectedSession?.laneId ?? laneId;
    if (!scopedLaneId) return projectRoot;
    const lane = lanes.find((entry) => entry.id === scopedLaneId);
    return lane?.worktreePath ?? projectRoot;
  }, [laneId, lanes, projectRoot, selectedSession?.laneId]);

  const selectedEvents = selectedSessionId ? eventsBySession[selectedSessionId] ?? [] : [];
  const optimisticOutgoingMessageRef = useRef<typeof optimisticOutgoingMessage>(null);
  const selectedEventsForDisplay = useMemo(() => {
    const baseEvents = optimisticOutgoingMessage && optimisticOutgoingMessage.sessionId === selectedSessionId
      ? [...selectedEvents, optimisticOutgoingMessage.envelope]
      : selectedEvents;
    const promotedTurnId = selectedSession?.cursorPromotedTurnId;
    const cloudAgentId = selectedSession?.cursorCloudAgentId;
    if (!promotedTurnId || !cloudAgentId) return baseEvents;
    if (baseEvents.some((env) => env.event.type === "system_notice" && env.event.noticeKind === "info" && env.event.message === "Promoted to Cursor Cloud")) {
      return baseEvents;
    }
    let insertAt = baseEvents.length;
    for (let i = 0; i < baseEvents.length; i += 1) {
      const evt = baseEvents[i]?.event;
      const turnId = evt && "turnId" in evt ? (evt as { turnId?: string }).turnId : undefined;
      if (turnId === promotedTurnId) {
        insertAt = i;
        break;
      }
    }
    const refEnvelope = baseEvents[insertAt] ?? baseEvents[baseEvents.length - 1];
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
    return [...baseEvents.slice(0, insertAt), synthetic, ...baseEvents.slice(insertAt)];
  }, [optimisticOutgoingMessage, selectedEvents, selectedSession?.cursorCloudAgentId, selectedSession?.cursorPromotedTurnId, selectedSessionId]);
  const selectedSubagentSnapshots = useMemo(() => deriveChatSubagentSnapshots(selectedEvents), [selectedEvents]);
  const selectedTurnDiffSummaries = useMemo(() => deriveTurnDiffSummaries(selectedEvents), [selectedEvents]);
  const selectedTodoItems = useMemo(() => deriveTodoItems(selectedEvents), [selectedEvents]);
  const pendingInput = selectedSessionId ? (pendingInputsBySession[selectedSessionId]?.[0] ?? null) : null;
  const selectedSessionAwaitingInput = Boolean(pendingInput) || selectedSession?.awaitingInput === true;
  const turnActive = selectedSessionId ? (turnActiveBySession[selectedSessionId] ?? false) : false;

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

    return () => {
      cancelled = true;
    };
  }, [
    initialSessionId,
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

  const syncComposerToSession = useCallback((session: AgentChatSessionSummary | null) => {
    if (!session) {
      setInteractionMode(initialNativeControls.interactionMode);
      setClaudePermissionMode(initialNativeControls.claudePermissionMode);
      setCodexApprovalPolicy(initialNativeControls.codexApprovalPolicy);
      setCodexSandbox(initialNativeControls.codexSandbox);
      setCodexConfigSource(initialNativeControls.codexConfigSource);
      setOpenCodePermissionMode(initialNativeControls.opencodePermissionMode);
      setDroidPermissionMode(initialNativeControls.droidPermissionMode);
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
  const cursorCloudModelIds = useMemo(
    () => effectiveAvailableModelIds.filter((id) => id.startsWith("cursor/")),
    [effectiveAvailableModelIds],
  );
  const cursorCloudAvailable = Boolean(laneId)
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
  const handoffCodexSelectValue: "default" | "plan" | "full-auto" | "config-toml" =
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

  const refreshAvailableModels = useCallback(async () => {
    const orderModelIds = (ids: Iterable<string>): string[] => {
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
    };
    const isCursorModelId = (id: string): boolean => (
      id.startsWith("cursor/")
      || getModelById(id)?.family === "cursor"
    );

    const selectedModelProvider = modelId.trim()
      ? resolveChatRuntimeProvider(getModelById(modelId))
      : null;
    const shouldRefreshOpenCodeInventory =
      sessionProvider === "opencode"
      && (
        selectedSession?.provider === "opencode"
        || selectedModelProvider === "opencode"
      );
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
        droid: status.providerConnections?.droid ?? null,
      });
      const available = deriveConfiguredModelIds(status, { includeDroid: true });
      const orderedAvailable = orderModelIds(available);
      setAvailableModelIds(orderedAvailable);
      const cursorReady = status.availableProviders?.cursor === true
        || status.providerConnections?.cursor?.runtimeAvailable === true;
      if (!cursorReady) return orderedAvailable;

      let cursorModels: Awaited<ReturnType<typeof getAgentChatModelsCached>>;
      try {
        cursorModels = await getAgentChatModelsCached({
          projectRoot,
          provider: "cursor",
          activateRuntime: true,
        });
      } catch {
        return orderedAvailable;
      }
      if (!cursorModels.length) {
        const withoutCursor = orderedAvailable.filter((id) => !isCursorModelId(id));
        setAvailableModelIds(withoutCursor);
        return withoutCursor;
      }

      const merged = new Set<string>(available);
      for (const model of cursorModels) {
        const resolved = resolveCliRegistryModelId("cursor", model.id);
        if (resolved) merged.add(resolved);
      }
      const withCursor = orderModelIds(merged);
      setAvailableModelIds(withCursor);
      return withCursor;
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

      const allAvailable = orderModelIds(available);
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

    const allRows = await window.ade.agentChat.list({ laneId });
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
      // ran, and the full history even when the transcript has been truncated
      // for size. Fall back to the disk-only readTranscriptTail path if the
      // snapshot call fails or the desktop app is running against an older
      // main-process build that lacks the handler.
      let parsed: AgentChatEventEnvelope[] = [];
      let usedSnapshotPath = false;
      try {
        if (typeof window.ade.agentChat.getEventHistory === "function") {
          const snapshot = await window.ade.agentChat.getEventHistory({
            sessionId,
            maxEvents: MAX_SELECTED_CHAT_SESSION_EVENTS,
          });
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
    selectedSession?.droidPermissionMode,
    selectedSession?.permissionMode,
    selectedSession?.cursorModeId,
    selectedSession?.cursorModeSnapshot?.currentModeId,
    selectedSession?.cursorModeSnapshot?.configOptions,
    syncComposerToSession,
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
      setProofDrawerOpen(false);
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

  const prevHandoffOpenRef = useRef(false);
  useEffect(() => {
    if (handoffOpen && !prevHandoffOpenRef.current) {
      setHandoffReasoningEffort(reasoningEffort ?? null);
      setHandoffClaudePermissionMode(claudePermissionMode);
      setHandoffCodexApprovalPolicy(codexApprovalPolicy);
      setHandoffCodexSandbox(codexSandbox);
      setHandoffCodexConfigSource(codexConfigSource);
      setHandoffOpenCodePermissionMode(opencodePermissionMode);
      setHandoffDroidPermissionMode(droidPermissionMode);
      setHandoffCursorModeId(cursorModeId);
      setHandoffCursorConfigValues({ ...cursorConfigValues });
    }
    prevHandoffOpenRef.current = handoffOpen;
    // Intentional: one-shot on open; avoid resetting the handoff form when underlying composer state changes while the menu is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoffOpen]);

  useEffect(() => {
    if (!handoffOpen || !handoffModelId) return;
    setHandoffReasoningEffort((prev) => clampHandoffReasoningToModel(prev, handoffTargetDescriptor));
  }, [handoffOpen, handoffModelId, handoffTargetDescriptor]);

  useEffect(() => {
    if (!isTileVisible) return;
    if (!selectedSessionId) return;
    if (!lockedSingleSessionMode) {
      // Re-read the selected transcript on every tab switch so the selected
      // chat can recover from any background event loss instead of relying
      // solely on the in-memory background buffer.
      void loadHistory(selectedSessionId, { force: true });
      return;
    }
    // Locked-single-session mode (Work tab tile). Force-reload on every mount
    // so that when the pane is unmounted and remounted (tab switch, project
    // switch, session tile activation) we always pull the freshest snapshot
    // rather than short-circuiting on a stale loadedHistoryRef from the
    // previous component instance.
    const hydrateDelayMs = isTileActive
      ? 120
      : 220 + (stableSessionDelayOffset(selectedSessionId) % 260);
    const handle = window.setTimeout(() => {
      void loadHistory(selectedSessionId, { force: true });
    }, hydrateDelayMs);
    return () => window.clearTimeout(handle);
  }, [isTileActive, isTileVisible, loadHistory, lockedSingleSessionMode, selectedSessionId]);

  useEffect(() => {
    if (!isTileActive) {
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
  }, [isTileActive, lockedSingleSessionMode, refreshComputerUseSnapshot, selectedSessionId]);

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
    if (!selectedSessionId || !isTileActive) { setSdkSlashCommands([]); return; }
    let cancelled = false;
    window.ade.agentChat.slashCommands({ sessionId: selectedSessionId })
      .then((cmds) => { if (!cancelled) setSdkSlashCommands(cmds); })
      .catch(() => { if (!cancelled) setSdkSlashCommands([]); });
    return () => { cancelled = true; };
  }, [isTileActive, selectedSessionId]);

  // Fetch git diff stats when the session changes or a turn completes
  useEffect(() => {
    if (!selectedSessionId || !isTileActive) { setSessionDelta(null); return; }
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
  }, [isTileActive, selectedSessionId, turnActive]);

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
    if (!isTileActive) return undefined;
    const unsubscribe = window.ade.computerUse.onEvent((event) => {
      if (!selectedSessionId) return;
      if (event.owner?.kind === "chat_session" && event.owner.id === selectedSessionId) {
        void refreshComputerUseSnapshot(selectedSessionId, { force: true });
      }
    });
    return unsubscribe;
  }, [isTileActive, refreshComputerUseSnapshot, selectedSessionId]);

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

    const onAddAttachment = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; attachment?: unknown }>).detail;
      if (!matchesThisChat(detail?.sessionId)) return;
      const attachment = detail.attachment as AgentChatFileRef | undefined;
      if (!attachment?.path) return;
      addAttachment(attachment);
    };
    const onInsertDraft = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; text?: unknown }>).detail;
      if (!matchesThisChat(detail?.sessionId) || typeof detail.text !== "string") return;
      insertComposerDraft(detail.text);
    };
    const onAddIosContext = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; item?: unknown }>).detail;
      if (!matchesThisChat(detail?.sessionId) || !detail.item) return;
      addIosElementContext(detail.item as IosElementContextItem);
    };
    const onAddAppControlContext = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; item?: unknown }>).detail;
      if (!matchesThisChat(detail?.sessionId) || !detail.item) return;
      addAppControlContext(detail.item as AppControlContextItem);
    };
    const onAddBuiltInBrowserContext = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionId?: unknown; item?: unknown }>).detail;
      if (!matchesThisChat(detail?.sessionId) || !detail.item) return;
      void addBuiltInBrowserContext(detail.item);
    };

    window.addEventListener("ade:agent-chat:add-attachment", onAddAttachment);
    window.addEventListener("ade:agent-chat:insert-draft", onInsertDraft);
    window.addEventListener("ade:agent-chat:add-ios-context", onAddIosContext);
    window.addEventListener("ade:agent-chat:add-app-control-context", onAddAppControlContext);
    window.addEventListener("ade:agent-chat:add-builtin-browser-context", onAddBuiltInBrowserContext);
    return () => {
      window.removeEventListener("ade:agent-chat:add-attachment", onAddAttachment);
      window.removeEventListener("ade:agent-chat:insert-draft", onInsertDraft);
      window.removeEventListener("ade:agent-chat:add-ios-context", onAddIosContext);
      window.removeEventListener("ade:agent-chat:add-app-control-context", onAddAppControlContext);
      window.removeEventListener("ade:agent-chat:add-builtin-browser-context", onAddBuiltInBrowserContext);
    };
  }, [addAppControlContext, addAttachment, addBuiltInBrowserContext, addIosElementContext, insertComposerDraft]);

  const removeAttachment = useCallback((attachmentPath: string) => {
    linkedIosAttachmentPathsRef.current.delete(attachmentPath);
    linkedAppControlAttachmentPathsRef.current.delete(attachmentPath);
    linkedBuiltInBrowserAttachmentPathsRef.current.delete(attachmentPath);
    setAttachments((prev) => prev.filter((entry) => entry.path !== attachmentPath));
    setIosElementContextItems((prev) => prev.filter((entry) => getIosContextAttachmentPath(entry) !== attachmentPath));
    setAppControlContextItems((prev) => prev.filter((entry) => getAppControlContextAttachmentPath(entry) !== attachmentPath));
    setBuiltInBrowserContextItems((prev) => prev.filter((entry) => getBuiltInBrowserContextAttachmentPath(entry) !== attachmentPath));
  }, []);

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

  useEffect(() => {
    if (!parallelChatMode) return;
    if (parallelModelSlots.length > 0) return;
    setParallelModelSlots([
      cloneParallelSlotFromComposer({
        native: currentNativeControls,
        modelId,
        reasoningEffort,
        executionMode,
      }),
      cloneParallelSlotFromComposer({
        native: currentNativeControls,
        modelId,
        reasoningEffort,
        executionMode,
      }),
    ]);
  }, [parallelChatMode, parallelModelSlots.length, currentNativeControls, modelId, reasoningEffort, executionMode]);

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
      // Only rebind the iOS simulator to a freshly created chat when the user
      // has opened the simulator drawer for THIS chat. The eager-create path
      // would otherwise steal ownership from a chat that is currently using
      // the simulator (e.g. switching to a new lane creates a new session
      // before any user gesture occurs).
      if (iosSimulatorOpen) {
        try {
          void window.ade.iosSimulator
            ?.attachToChatSession?.({ chatSessionId: created.id })
            ?.catch(() => { /* attach is best-effort; sim may not be running or already owned */ });
        } catch { /* iosSimulator API may be unavailable in some environments */ }
      }
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
  }, [buildNativeControlPayload, currentNativeControls, iosSimulatorOpen, laneId, modelId, notifySessionCreated, reasoningEffort, refreshSessions, touchSession]);

  const handoffSession = useCallback(async () => {
    if (!canShowHandoff || !selectedSessionId || !handoffModelId || handoffBlocked) return;
    setError(null);
    setHandoffBusy(true);
    try {
      const resolvedHandoffPermissionMode = handoffNativePermissionMode ?? selectedSession?.permissionMode;
      const result = await window.ade.agentChat.handoff({
        sourceSessionId: selectedSessionId,
        targetModelId: handoffModelId,
        reasoningEffort: handoffReasoningEffort,
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
      setHandoffOpen(false);
      notifySessionCreated(result.session);
      void refreshSessions().catch(() => {});
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
    handoffCodexSandbox,
    handoffCursorConfigValues,
    handoffCursorModeId,
    handoffDroidPermissionMode,
    handoffModelId,
    handoffNativePermissionMode,
    handoffOpenCodePermissionMode,
    handoffReasoningEffort,
    notifySessionCreated,
    refreshSessions,
    selectedSession?.permissionMode,
    selectedSessionId,
  ]);

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

  const handleArchiveChat = useCallback((sessionId: string) => {
    setError(null);
    void window.ade.agentChat.archive({ sessionId })
      .then(async () => {
        invalidateSessionListCache();
        if (selectedSessionIdRef.current === sessionId) {
          setSelectedSessionId(null);
        }
        await refreshSessions().catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Archive failed: ${message}`);
      });
  }, [refreshSessions]);

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
        await refreshSessions().catch(() => {});
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        setError(`Restore failed: ${message}`);
      });
  }, [refreshSessions]);

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
    if (submitInFlightRef.current || busy || parallelLaunchBusy) return;
    if (selectedSessionId) {
      const sessionPending = pendingInputsBySession[selectedSessionId] ?? [];
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
      if ((!text.length && attachments.length === 0) || !laneId || !projectRoot) return;
      if (parallelModelSlots.length < 2) {
        setError("Add at least two models for a parallel launch.");
        return;
      }
      const emptySlot = parallelModelSlots.find(s => !s.modelId?.trim());
      if (emptySlot) {
        setError("All parallel lanes must have a model selected.");
        return;
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

      const draftSnapshot = draft;
      const attachmentsSnapshot = [...attachments];
      submitInFlightRef.current = true;
      setParallelLaunchBusy(true);
      setParallelLaunchStatus("Naming lanes…");
      setError(null);
      const createdLaneIds: string[] = [];
      const sentLaneIds: string[] = [];
      const sessionByLane = new Map<string, string>();
      try {
        let namingSeed = text;
        if (!text.length && attachmentsSnapshot.length) {
          const imageCount = attachmentsSnapshot.filter((a) => a.type === "image").length;
          const fileCount = attachmentsSnapshot.filter((a) => a.type === "file").length;
          namingSeed = [
            "Parallel attachment task",
            imageCount ? `${imageCount} image${imageCount === 1 ? "" : "s"}` : null,
            fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : null,
          ].filter(Boolean).join(" · ");
        }
        const baseName = await window.ade.agentChat.suggestLaneName({
          laneId,
          prompt: namingSeed,
          modelId: parallelModelSlots[0]!.modelId,
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
            ...buildNativeControlPayloadForSlot(slot, provider),
          });
          sessionByLane.set(childLane.id, created.id);
        }

        await refreshLanesStore();

        const { sendText, displayText: displayForSend } = buildParallelLaunchPrompt({
          text,
          attachmentCount: attachmentsSnapshot.length,
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
          try {
            await window.ade.agentChat.send({
              sessionId,
              text: sendText,
              displayText: displayForSend,
              attachments: attachmentsSnapshot,
              reasoningEffort: slot.reasoningEffort,
              executionMode: slot.executionMode,
              interactionMode: provider === "claude" ? slot.interactionMode : null,
            });
          } catch (sendError) {
            const sendMsg = sendError instanceof Error ? sendError.message : String(sendError);
            const isBusyErr = /turn is already active|already active/i.test(sendMsg);
            if (isBusyErr) {
              await window.ade.agentChat.steer({
                sessionId,
                text: sendText,
                ...(attachmentsSnapshot.length ? { attachments: attachmentsSnapshot } : {}),
              });
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

    if (!modelId) return;
    const text = draft.trim();
    const iosContextSnapshot = [...iosElementContextItems];
    const appControlContextSnapshot = [...appControlContextItems];
    const builtInBrowserContextSnapshot = [...builtInBrowserContextItems];
    const iosContextPrefix = formatIosElementContextForPrompt(iosContextSnapshot);
    const appControlContextPrefix = formatAppControlContextForPrompt(appControlContextSnapshot);
    const builtInBrowserContextPrefix = formatBuiltInBrowserContextForPrompt(builtInBrowserContextSnapshot);
    const iosContextDisplayChips = formatIosElementContextChipsForDisplay(iosContextSnapshot);
    const appControlContextDisplayChips = formatAppControlContextChipsForDisplay(appControlContextSnapshot);
    const builtInBrowserContextDisplayChips = formatBuiltInBrowserContextChipsForDisplay(builtInBrowserContextSnapshot);
    const visualContextPrefix = [iosContextPrefix, appControlContextPrefix, builtInBrowserContextPrefix].filter(Boolean).join("\n");
    const visualContextDisplayChips = [iosContextDisplayChips, appControlContextDisplayChips, builtInBrowserContextDisplayChips].filter(Boolean).join(" ");
    if ((!text.length && !visualContextPrefix.length) || !laneId) return;
    const pendingNativeControlUpdate = pendingNativeControlUpdateRef.current;
    if (selectedSessionId && pendingNativeControlUpdate?.sessionId === selectedSessionId) {
      try {
        await pendingNativeControlUpdate.promise;
      } catch {
        return;
      }
    }
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
      let finalText = visualContextPrefix ? `${visualContextPrefix}${text}` : text;
      const finalDisplayText = visualContextDisplayChips
        ? text.length
          ? `${visualContextDisplayChips} ${text}`
          : visualContextDisplayChips
        : text;

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
          text: finalDisplayText || finalText,
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

      if (turnActiveBySession[sessionId]) {
        setOptimisticOutgoingMessage(null);
        await window.ade.agentChat.steer({
          sessionId,
          text: finalText,
          ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
        });
      } else {
        try {
          setOptimisticOutgoingMessage({ sessionId, envelope: optimisticEnvelope(sessionId) });
          await window.ade.agentChat.send({
            sessionId,
            text: finalText,
            displayText: finalDisplayText || "Selected visual app context",
            attachments: selectedAttachments,
            reasoningEffort,
            executionMode: launchModeEditable ? executionMode : null,
            interactionMode: sessionProvider === "claude" ? interactionMode : null,
            ...(sessionProvider === "cursor" ? { runtime: cursorRuntime } : {}),
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
              text: finalText,
              ...(selectedAttachments.length ? { attachments: selectedAttachments } : {}),
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
      setIosElementContextItems([]);
      setAppControlContextItems([]);
      setBuiltInBrowserContextItems([]);
    } catch (submitError) {
      const message = submitError instanceof Error ? submitError.message : String(submitError);
      setDraft((current) => (current.trim().length ? current : draftSnapshot));
      setAttachments((current) => (current.length ? current : attachmentsSnapshot));
      setIosElementContextItems((current) => (current.length ? current : iosContextSnapshot));
      setAppControlContextItems((current) => (current.length ? current : appControlContextSnapshot));
      setBuiltInBrowserContextItems((current) => (current.length ? current : builtInBrowserContextSnapshot));
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
    interactionMode,
    laneId,
    launchModeEditable,
    modelId,
    reasoningEffort,
    pendingInputsBySession,
    refreshAvailableModels,
    refreshSessions,
    selectedSessionId,
    selectedSession?.awaitingInput,
    selectedSessionModelId,
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
    isPersistentIdentitySurface,
    patchSessionSummary,
    reasoningEffort,
    refreshSessions,
    selectedSessionId,
    sessionMutationKind,
  ]);

  const handleComputerUsePolicyChange = useCallback(async (_nextPolicy: unknown) => {
    // Computer-use policy gating has been removed; this handler is a no-op retained for UI compat.
  }, []);

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
  const proofArtifactCount = computerUseSnapshot?.artifacts?.length ?? 0;
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
            setTerminalRevealRequest({ ...terminal, nonce: Date.now() });
          }}
          onAddContext={addAppControlContext}
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

        {showWorkspaceChrome && laneId ? <ChatGitToolbar laneId={laneId} /> : null}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
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
                  "relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
                  iosSimulatorOpen
                    ? "border-cyan-300/22 bg-cyan-500/10 text-cyan-100/80"
                    : "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.10] hover:text-fg/65",
                )}
                onClick={() => {
                  setIosSimulatorOpen((current) => {
                    const next = !current;
                    if (next) {
                      setProofDrawerOpen(false);
                      setAppControlOpen(false);
                      setCursorCloudPaneOpen(false);
                    }
                    return next;
                  });
                }}
                aria-label={iosSimulatorOpen ? "Close iOS simulator drawer" : "Open iOS simulator drawer"}
                aria-pressed={iosSimulatorOpen}
              >
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
                  "relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
                  appControlOpen
                    ? "border-sky-300/22 bg-sky-500/10 text-sky-100/80"
                    : "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.10] hover:text-fg/65",
                )}
                onClick={() => {
                  setAppControlOpen((current) => {
                    const next = !current;
                    if (next) {
                      setProofDrawerOpen(false);
                      setIosSimulatorOpen(false);
                    }
                    return next;
                  });
                }}
                aria-label={appControlOpen ? "Close App Control drawer" : "Open App Control drawer"}
                aria-pressed={appControlOpen}
              >
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
            <SmartTooltip
              content={{
                label: proofDrawerOpen ? "Close proof drawer" : "Open proof drawer",
                description: proofDrawerOpen
                  ? "Hide captured screenshots, videos, browser traces, and proof artifacts."
                  : "Show captured screenshots, videos, browser traces, and proof artifacts for this chat.",
                effect: proofArtifactCount > 0 ? `${proofArtifactCount} artifact${proofArtifactCount === 1 ? "" : "s"} available.` : undefined,
              }}
            >
              <button
                type="button"
                className={cn(
                  "relative inline-flex h-7 w-7 items-center justify-center rounded-md border transition-colors",
                  proofDrawerOpen
                    ? "border-emerald-400/22 bg-emerald-500/10 text-emerald-100/80"
                    : "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.10] hover:text-fg/65",
                )}
                onClick={() => {
                  setProofDrawerOpen((current) => {
                    const next = !current;
                    if (next) {
                      setIosSimulatorOpen(false);
                      setCursorCloudPaneOpen(false);
                      setAppControlOpen(false);
                    }
                    return next;
                  });
                }}
                title={proofDrawerOpen ? "Close proof drawer" : "Open proof drawer"}
                aria-label={proofDrawerOpen ? "Close proof drawer" : "Open proof drawer"}
                aria-pressed={proofDrawerOpen}
              >
                <Cube size={13} weight={proofDrawerOpen ? "fill" : "regular"} />
                {proofArtifactCount > 0 ? (
                  <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 bg-emerald-500/80 px-0.5 font-mono text-[8px] font-bold text-black">
                    {proofArtifactCount}
                  </span>
                ) : null}
              </button>
            </SmartTooltip>
          ) : null}
          {showWorkspaceChrome && laneId ? <ChatTerminalToggle open={terminalDrawerOpen} onToggle={() => setTerminalDrawerOpen((v) => !v)} /> : null}
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
                <div className="absolute right-0 top-full z-[100] mt-2 w-[min(26rem,calc(100vw-2rem))] rounded-[14px] border border-violet-400/[0.10] bg-[#13101a] p-4 shadow-[0_20px_50px_-12px_rgba(0,0,0,0.55)]">
                  <div className="space-y-1">
                    <div className="font-sans text-[12px] font-semibold text-fg/82">Start a sibling chat on another model</div>
                    <div className="text-[11px] leading-5 text-fg/54">
                      ADE will create a new work chat, inject a handoff summary from this session, and route you into the new tab.
                    </div>
                    {laneId ? (
                      <div className="text-[10px] leading-4 text-fg/40">
                        New session stays in this lane ({laneDisplayLabel}).
                      </div>
                    ) : null}
                  </div>
                  <div className="mt-3">
                    <ProviderModelSelector
                      value={handoffModelId}
                      onChange={setHandoffModelId}
                      availableModelIds={handoffAvailableModelIds}
                      showReasoning
                      reasoningEffort={handoffReasoningEffort}
                      onReasoningEffortChange={setHandoffReasoningEffort}
                      onOpenAiSettings={openAiProvidersSettings}
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
              setError(null);
              setSelectedSessionId(null);
              setDraft("");
              setAttachments([]);
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

  const embedDraft = embeddedWorkLayout && forceDraft;
  const compactShell = embedDraft || layoutVariant === "grid-tile";
  const isEmptyState = !selectedSessionId;

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
            droidPermissionMode={droidPermissionMode}
            cursorModeSnapshot={effectiveCursorModeSnapshot}
            executionMode={selectedExecutionMode?.value ?? "focused"}
            computerUseSnapshot={computerUseSnapshot}
            iosElementContextItems={iosElementContextItems}
            appControlContextItems={appControlContextItems}
            builtInBrowserContextItems={builtInBrowserContextItems}
            executionModeOptions={launchModeEditable ? executionModeOptions : []}
            modelSelectionLocked={modelSelectionLocked || sessionMutationKind === "model" || turnActive}
            permissionModeLocked={permissionModeLocked || identitySessionSettingsBusy}
            hideNativeControls={hideNativeControls}
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
                  droidPermissionMode: updatedSession.droidPermissionMode,
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
            onReasoningEffortChange={handleReasoningEffortChange}
            onDraftChange={updateComposerDraft}
            onClearDraft={() => updateComposerDraft("")}
            onSubmit={() => {
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
              embeddedWorkLayout && forceDraft && !lockSessionId && !initialSessionId && selectedSessionId == null,
            )}
            showIosSimulatorToggle={laneToolsVisible && iosSimulatorAvailable}
            iosSimulatorOpen={iosSimulatorOpen}
            onToggleIosSimulator={() => {
              setIosSimulatorOpen((current) => {
                const next = !current;
                if (next) {
                  setProofDrawerOpen(false);
                  setCursorCloudPaneOpen(false);
                  setAppControlOpen(false);
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
                  setProofDrawerOpen(false);
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
            }}
            onCloseCloudLaunchMode={() => setCursorCloudLaunchModeOpen(false)}
            onOpenCloudBringToLocal={() => {
              setCursorCloudLaunchModeOpen(false);
              setProofDrawerOpen(false);
              setIosSimulatorOpen(false);
              setCursorCloudPaneOpen(true);
            }}
            onSubmitToCloud={async (promptText) => {
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
              const desc = getModelById(nextModelId);
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

  const composerWithTypographyRoot = (
    <div
      data-chat-appearance-root
      style={chatAppearanceRootStyle}
      className={compactShell ? "min-w-0 w-full" : undefined}
    >
      {composerElement}
    </div>
  );

  // True when a non-proof companion panel is open. These panels (iOS simulator,
  // App Control) host their own input affordances, so the empty-state layout
  // shrinks the hero and moves the composer below.
  const appPanelOpen = effectiveIosSimulatorOpen || effectiveAppControlOpen;
  const rightPaneOpen = proofDrawerOpen || appPanelOpen;
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

  return (
    <>
      <ChatSurfaceShell
        containerRef={shellRef}
        mode={surfaceMode}
        accentColor={presentation?.accentColor ?? draftAccent}
        contentScale={1}
        chromeTint={chatChromeTint}
        shellGeometry={chatShellGeometry}
        className={compactShell ? cn("border-0 shadow-none rounded-none bg-transparent") : undefined}
        header={compactShell ? undefined : shellHeader}
        footer={isEmptyState || appPanelOpen ? undefined : composerWithTypographyRoot}
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
                  <div
                    data-chat-appearance-root
                    style={{ ...chatAppearanceRootStyle, ...splitChatColStyle }}
                    className={cn(
                      "flex min-h-0 flex-1 basis-0 flex-col overflow-hidden",
                      layoutVariant === "grid-tile" ? "min-w-0" : "min-w-[280px]",
                    )}
                  >
                    {selectedSession?.cursorRuntime === "cloud" && selectedSession?.cursorCloudAgentId ? (
                      <div
                        className="shrink-0 border-b border-violet-300/20 bg-violet-500/[0.06] px-4 py-1.5 font-sans text-[11px] leading-snug text-violet-100/85"
                        role="status"
                      >
                        Live view of Cursor Cloud agent. Replies run in cloud.
                      </div>
                    ) : null}
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
                    {showWorkspaceChrome ? (
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
                  {proofDrawerOpen ? renderRightPane(proofPanelContent) : null}
                  {effectiveIosSimulatorOpen ? renderRightPane(iosSimulatorPanelContent) : null}
                  {effectiveAppControlOpen ? renderRightPane(appControlPanelContent) : null}
                  {cursorCloudPaneOpen && cursorCloudAvailable ? renderRightPane(cursorCloudPanelContent) : null}
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
                      appPanelOpen ? "px-3" : "px-6",
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
                          Start a new conversation
                        </h2>

                        {/* Lane selector pill */}
                        {showWorkspaceChrome && availableLanes && availableLanes.length > 0 && onLaneChange ? (
                          <motion.div
                            className="flex justify-center"
                            exit={{ opacity: 0, transition: { duration: 0.15 } }}
                          >
                            <LaneCombobox
                              lanes={availableLanes}
                              value={laneId ?? ""}
                              onChange={onLaneChange}
                              variant="pill"
                              aria-label="Select lane"
                            />
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
                  {cursorCloudPaneOpen && cursorCloudAvailable ? renderRightPane(cursorCloudPanelContent) : null}
                </motion.div>
              )}
            </AnimatePresence>
          )}
        </div>
      </ChatSurfaceShell>
      <ConfirmDialog state={archiveConfirm.state} onClose={archiveConfirm.close} />
    </>
  );
}
