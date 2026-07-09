import React, { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowBendDownRight, ArrowUp, At, Bug, CaretDown, Check, CloudArrowUp, Desktop, DeviceMobile, GearSix, GithubLogo, Globe, Image, Lightning, MicrophoneSlash, Paperclip, PencilSimple, Plus, RocketLaunch, ShieldCheck, ShieldWarning, Square, SquareSplitHorizontal, Strategy, Trash, X } from "@phosphor-icons/react";
import { BorderBeam } from "border-beam";
import {
  inferAttachmentType,
  PARALLEL_CHAT_MAX_ATTACHMENTS,
  type AgentChatApprovalDecision,
  type AgentChatContextAttachment,
  type AgentChatClaudePermissionMode,
  type AgentChatCursorConfigOption,
  type AgentChatCursorModeSnapshot,
  type AgentChatDroidPermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatExecutionMode,
  type AgentChatFileRef,
  type AgentChatInteractionMode,
  type AgentChatOpenCodePermissionMode,
  type AgentChatSlashCommand,
  type ComputerUseOwnerSnapshot,
  type ChatSurfaceMode,
  type AppControlContextItem,
  type BuiltInBrowserContextItem,
  type IosElementContextItem,
  type LaneLinearIssue,
  type PendingInputRequest,
  type AgentChatModelCatalogRefreshProvider,
} from "../../../shared/types";
import {
  buildChatContextAttachmentPrompt,
  makeLinearIssueContextAttachment,
} from "../../../shared/chatContextAttachments";
import type {
  ModelSelection,
  OrchestrationModelSelectionMetadata,
  OrchestrationRole,
} from "../../../shared/types/orchestration";
import { getModelById, modelSupportsFastMode, type ProviderFamily } from "../../../shared/modelRegistry";
import {
  composerTriggerSpansWholeDraft,
  detectComposerTrigger,
  findConfirmedComposerTokens,
  replaceComposerTriggerSpan,
  type ComposerTrigger,
} from "../../../shared/composerTriggers";
import { cn } from "../ui/cn";
import { ModelPicker } from "../shared/ModelPicker/ModelPicker";
import type { AuthStatus } from "../shared/ModelPicker/ModelPickerRail";
import { resolveModelDescriptorWithRuntimeCatalog } from "../shared/ModelPicker/modelCatalog";
import { ReasoningEffortPicker } from "../shared/ModelPicker/ReasoningEffortPicker";
import { getPermissionOptions, type PermissionOption } from "../shared/permissionOptions";
import { ContextUsageDial } from "./usage/ContextUsageDial";
import type { ContextUsageViewModel } from "./usage/contextUsageModel";
import {
  ChatAttachmentTray,
  CHAT_IMAGE_ATTACHMENT_FOCUS_SELECTOR,
  type ChatAttachmentPendingImage,
} from "./ChatAttachmentTray";
import { ChatComposerShell } from "./ChatComposerShell";
import { LinearIssueSelectModal } from "../app/LinearIssueSelectModal";
import { LinearMark, LINEAR_BRAND } from "../lanes/linearBrand";
import { hasPendingInputOptions } from "./pendingInput";
import { CURSOR_MODE_LABELS } from "../../../shared/cursorModes";
import { ChatProposedPlanCard } from "./ChatProposedPlanCard";
import { ChatModelSelectionPendingCard } from "./ChatModelSelectionPendingCard";
import { ChatCommandMenu, type ChatCommandMenuItem, type ChatCommandMenuHandle } from "./ChatCommandMenu";
import { modifierKeyLabel } from "../../lib/platform";
import { canOpenInAdeBrowser, openUrlInAdeBrowser } from "../../lib/openExternal";
import { SmartTooltip } from "../ui/SmartTooltip";
import { VoiceDictationButton } from "./VoiceDictationButton";
import { ProviderLogo } from "../shared/ProviderLogos";
import { pendingInputHeaderLabel } from "../../../shared/pendingInputLabels";
import { useAppStore, rootAppStoreApi } from "../../state/appStore";
import { useVoiceModelInstalled } from "../../hooks/useVoiceModelInstalled";

const MAX_TEMP_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const CLIPBOARD_IMAGE_PASTE_FALLBACK_DELAY_MS = 80;
const BASE64_ENCODE_CHUNK_SIZE = 0x8000;
const ISSUE_CONTEXT_MENU_WIDTH = 256;
const ISSUE_CONTEXT_MENU_GAP = 8;
const ISSUE_CONTEXT_MENU_VIEWPORT_GUTTER = 8;
const IMAGE_URL_EXTENSION_RE = /\.(png|jpe?g|gif|webp|bmp|svg|ico|tiff?)$/i;

const voiceShimmerStyleId = "ade-voice-shimmer-effects";

/** Inject the dictation insert-shimmer keyframes once; reduce-motion disables it. */
function ensureVoiceShimmerStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(voiceShimmerStyleId)) return;
  const sheet = document.createElement("style");
  sheet.id = voiceShimmerStyleId;
  sheet.textContent = `
    @keyframes ade-voice-shimmer-sweep {
      0% { background-position: -150% 0; }
      100% { background-position: 250% 0; }
    }
    .ade-voice-shimmer::after {
      content: "";
      position: absolute;
      inset: 0;
      pointer-events: none;
      border-radius: inherit;
      background: linear-gradient(100deg, transparent 30%, color-mix(in srgb, var(--chat-accent) 22%, transparent) 50%, transparent 70%);
      background-size: 200% 100%;
      animation: ade-voice-shimmer-sweep 1s ease-out 1;
    }
    @media (prefers-reduced-motion: reduce) {
      .ade-voice-shimmer::after { animation: none; background: none; }
    }
  `;
  document.head.appendChild(sheet);
}

/**
 * Best-effort decoder for the `providerMetadata` payload carried on a
 * `model_selection` PendingInputRequest. The server packs
 * `OrchestrationModelSelectionMetadata` into the metadata bag; here we
 * recover it defensively so a malformed payload renders an empty picker
 * rather than crashing the composer.
 */
function readOrchestrationModelSelectionMetadata(
  value: Record<string, unknown> | undefined,
): OrchestrationModelSelectionMetadata | null {
  if (!value || typeof value !== "object") return null;
  const role = value.role;
  if (role !== "lead" && role !== "worker" && role !== "validator") return null;
  const tag = typeof value.tag === "string" ? value.tag : "";
  const workDescription =
    typeof value.workDescription === "string" && value.workDescription.trim()
      ? value.workDescription
      : null;
  const filesHint = Array.isArray(value.filesHint)
    ? value.filesHint.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const dependsOn = Array.isArray(value.dependsOn)
    ? value.dependsOn.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    : undefined;
  const rawSuggested = value.suggested;
  let suggested: ModelSelection | undefined;
  if (rawSuggested && typeof rawSuggested === "object") {
    const r = rawSuggested as Record<string, unknown>;
    const sProvider = typeof r.provider === "string" ? r.provider : null;
    const sModelId = typeof r.modelId === "string" ? r.modelId : null;
    if (sProvider && sModelId) {
      suggested = {
        provider: sProvider as ModelSelection["provider"],
        modelId: sModelId,
        ...(typeof r.reasoningEffort === "string" || r.reasoningEffort === null
          ? { reasoningEffort: r.reasoningEffort as string | null }
          : {}),
        ...(typeof r.fastMode === "boolean" ? { fastMode: r.fastMode } : {}),
      };
    }
  }
  return {
    role,
    tag,
    ...(workDescription ? { workDescription } : {}),
    ...(filesHint && filesHint.length ? { filesHint } : {}),
    ...(dependsOn && dependsOn.length ? { dependsOn } : {}),
    ...(suggested ? { suggested } : {}),
    ...(value.availableModels !== undefined ? { availableModels: value.availableModels } : {}),
  };
}

type PasteShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
};

function isMacPlatform(): boolean {
  return typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
}

function isMacPasteShortcut(event: PasteShortcutEvent): boolean {
  return (
    isMacPlatform()
    && event.key.toLowerCase() === "v"
    && event.metaKey
    && !event.ctrlKey
    && !event.altKey
    && !event.shiftKey
  );
}

/**
 * Returns the normalized image URL only when `value` is *exactly* a URL with no
 * other text around it (whitespace ok). We never want a paste to be silently
 * swallowed if the user actually intended to paste a paragraph of text that
 * happens to start with a URL.
 */
function normalizeImageAttachmentUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  // Reject if there are any embedded newlines or whitespace — must be a single token.
  if (/\s/.test(raw)) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!IMAGE_URL_EXTENSION_RE.test(parsed.pathname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const parts: string[] = [];
  for (let i = 0; i < bytes.length; i += BASE64_ENCODE_CHUNK_SIZE) {
    const chunk = bytes.subarray(i, i + BASE64_ENCODE_CHUNK_SIZE);
    parts.push(String.fromCharCode(...chunk));
  }
  return btoa(parts.join(""));
}

function getIssueContextMenuStyle(trigger: HTMLButtonElement): React.CSSProperties {
  const rect = trigger.getBoundingClientRect();
  const maxLeft = Math.max(
    ISSUE_CONTEXT_MENU_VIEWPORT_GUTTER,
    window.innerWidth - ISSUE_CONTEXT_MENU_WIDTH - ISSUE_CONTEXT_MENU_VIEWPORT_GUTTER,
  );
  const left = Math.min(
    Math.max(ISSUE_CONTEXT_MENU_VIEWPORT_GUTTER, rect.right - ISSUE_CONTEXT_MENU_WIDTH),
    maxLeft,
  );

  return {
    left,
    bottom: Math.max(ISSUE_CONTEXT_MENU_VIEWPORT_GUTTER, window.innerHeight - rect.top + ISSUE_CONTEXT_MENU_GAP),
    width: ISSUE_CONTEXT_MENU_WIDTH,
  };
}

type ExecutionModeOption = {
  value: AgentChatExecutionMode;
  label: string;
  summary: string;
  helper: string;
  accent: string;
};

type SlashCommandEntry = {
  command: string;
  label: string;
  description: string;
  argumentHint?: string;
  source: "sdk" | "local";
};

type CommandMenuAnchor = { top: number; left: number; bottom: number };

function getCommandMenuAnchor(element: HTMLElement | null): CommandMenuAnchor | null {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  return {
    top: rect.top,
    bottom: rect.bottom,
    left: rect.left + 16,
  };
}

function iosMetadataRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function iosMetadataArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(iosMetadataRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
}

function iosContextDisplayLabel(item: IosElementContextItem): string {
  const metadata = item.metadata ?? {};
  for (const value of [metadata.label, metadata.value, item.componentId, metadata.role, metadata.elementType]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "iOS element";
}

function iosContextSourceDescription(item: IosElementContextItem): string {
  if (item.sourceFile) {
    return `${item.sourceFile.split("/").pop()}${item.sourceLine ? `:${item.sourceLine}` : ""}`;
  }
  const confidence = typeof item.metadata.sourceConfidence === "string" ? item.metadata.sourceConfidence : null;
  const candidates = iosMetadataArray(item.metadata.sourceCandidates ?? item.metadata.sourceMatches);
  if (confidence === "candidate" || candidates.length) return `${candidates.length || "Candidate"} source ${candidates.length === 1 ? "guess" : "guesses"}`;
  return typeof item.metadata.screenElementSource === "string" ? item.metadata.screenElementSource : "No source match";
}

function iosFrameLabel(item: IosElementContextItem): string | null {
  if (!item.frame) return null;
  return `x ${Math.round(item.frame.x)}, y ${Math.round(item.frame.y)}, w ${Math.round(item.frame.width)}, h ${Math.round(item.frame.height)}`;
}

function appControlContextDisplayLabel(item: AppControlContextItem): string {
  const metadata = item.metadata ?? {};
  for (const value of [metadata.label, metadata.value, item.componentId, metadata.role, metadata.tagName]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "App element";
}

function appControlContextSourceDescription(item: AppControlContextItem): string {
  if (item.sourceFile) {
    return `${item.sourceFile.split("/").pop()}${item.sourceLine ? `:${item.sourceLine}` : ""}`;
  }
  const candidates = iosMetadataArray(item.metadata.sourceCandidates);
  if (candidates.length) return `${candidates.length} source ${candidates.length === 1 ? "guess" : "guesses"}`;
  if (item.provider === "coordinate-fallback") return "Coordinate selection";
  return typeof item.metadata.provider === "string" ? item.metadata.provider : item.provider;
}

function appControlContextRoleHint(item: AppControlContextItem): string | null {
  const metadata = item.metadata ?? {};
  const role = typeof metadata.role === "string" ? metadata.role.trim() : null;
  if (role) return role;
  const tag = typeof metadata.tagName === "string" ? metadata.tagName.trim() : null;
  return tag ? tag.toLowerCase() : null;
}

function appControlContextFrameHint(item: AppControlContextItem): string | null {
  if (!item.frame) return null;
  return `${Math.round(item.frame.width)}×${Math.round(item.frame.height)} @ ${Math.round(item.frame.x)},${Math.round(item.frame.y)}`;
}

function builtInBrowserContextDisplayLabel(item: BuiltInBrowserContextItem): string {
  const metadata = item.metadata ?? {};
  for (const value of [metadata.label, metadata.text, metadata.value, item.componentId, metadata.selector, metadata.role, metadata.tagName]) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "Browser element";
}

function builtInBrowserContextSourceDescription(item: BuiltInBrowserContextItem): string {
  const url = typeof item.url === "string" && item.url.trim()
    ? item.url
    : typeof item.metadata.url === "string" ? item.metadata.url : null;
  if (!url) return "Global browser";
  try {
    const parsed = new URL(url);
    return parsed.hostname || "Global browser";
  } catch {
    return url;
  }
}

function builtInBrowserContextRoleHint(item: BuiltInBrowserContextItem): string | null {
  const metadata = item.metadata ?? {};
  const role = typeof metadata.role === "string" ? metadata.role.trim() : null;
  if (role) return role;
  const tag = typeof metadata.tagName === "string" ? metadata.tagName.trim() : null;
  return tag ? tag.toLowerCase() : null;
}

function builtInBrowserContextFrameHint(item: BuiltInBrowserContextItem): string | null {
  if (!item.frame) return null;
  return `${Math.round(item.frame.width)}×${Math.round(item.frame.height)} @ ${Math.round(item.frame.x)},${Math.round(item.frame.y)}`;
}

/** When set, permission/runtime controls bind to this slot (parallel model row configuration). */
export type ParallelComposerControlSlot = {
  sessionProvider: string;
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
  droidPermissionMode: AgentChatDroidPermissionMode;
  cursorModeSnapshot: AgentChatCursorModeSnapshot | null;
  onInteractionModeChange: (mode: AgentChatInteractionMode) => void;
  onClaudeModeChange: (mode: AgentChatClaudePermissionMode) => void;
  onClaudePermissionModeChange: (mode: AgentChatClaudePermissionMode) => void;
  onCodexPresetChange: (next: {
    codexApprovalPolicy: AgentChatCodexApprovalPolicy;
    codexSandbox: AgentChatCodexSandbox;
    codexConfigSource: AgentChatCodexConfigSource;
  }) => void;
  onCodexApprovalPolicyChange: (policy: AgentChatCodexApprovalPolicy) => void;
  onCodexSandboxChange: (sandbox: AgentChatCodexSandbox) => void;
  onCodexConfigSourceChange: (source: AgentChatCodexConfigSource) => void;
  onOpenCodePermissionModeChange: (mode: AgentChatOpenCodePermissionMode) => void;
  onDroidPermissionModeChange: (mode: AgentChatDroidPermissionMode) => void;
  onCursorModeChange: (modeId: string) => void;
  onCursorConfigChange: (configId: string, value: string | boolean) => void;
};

function getComposerInputLockMessage(pendingInput: PendingInputRequest | null | undefined): string | null {
  if (!pendingInput) return null;
  if (pendingInput.kind === "question" || pendingInput.kind === "structured_question") {
    return "Answer the question card above, or decline it.";
  }
  return "Resolve the pending request above before sending another message.";
}

function getAttachBlockedReason(args: {
  composerInputLocked: boolean;
  composerInputLockMessage: string | null;
  parallelChatMode: boolean;
  attachmentCount: number;
}): string | null {
  if (args.composerInputLocked) {
    return args.composerInputLockMessage ?? "Resolve the pending request before adding attachments.";
  }
  if (args.parallelChatMode && args.attachmentCount >= PARALLEL_CHAT_MAX_ATTACHMENTS) {
    return `Maximum ${PARALLEL_CHAT_MAX_ATTACHMENTS} attachments for parallel launch`;
  }
  return null;
}

function normalizeComposerLabelText(value: string): string {
  return value.trim().replace(/\s*\.\.\.$/, "").trim();
}

function iosSourceResolutionLabel(resolution: string): string {
  switch (resolution) {
    case "ade-inspector":
      return "Source from ADEInspector";
    case "swift-exact-search":
      return "Exact Swift source match";
    case "swift-candidate-search":
      return "Ranked Swift source candidates";
    default:
      return "No source match";
  }
}

/** Local-only commands that are always available regardless of provider. */
const LOCAL_SLASH_COMMANDS: SlashCommandEntry[] = [
  { command: "/clear", label: "Clear", description: "Clear chat history", source: "local" },
];

/** Build the effective slash command list by merging SDK-provided commands with local ones. */
function buildSlashCommands(
  sdkCommands: AgentChatSlashCommand[],
  options: { includeLocalClear: boolean },
): SlashCommandEntry[] {
  const result: SlashCommandEntry[] = [];
  const seen = new Set<string>();

  // SDK commands first -- they take priority
  for (const cmd of sdkCommands) {
    const name = cmd.name.startsWith("/") ? cmd.name : `/${cmd.name}`;
    if (seen.has(name)) continue;
    seen.add(name);
    result.push({
      command: name,
      label: name.slice(1).charAt(0).toUpperCase() + name.slice(2),
      description: cmd.description || `Run ${name}`,
      argumentHint: cmd.argumentHint,
      source: cmd.source,
    });
  }

  // Local commands that aren't already provided by SDK. Skip /clear when no
  // handler is wired up — otherwise selecting it falls through to the generic
  // draft path and sends literal "/clear" text to the model.
  for (const cmd of LOCAL_SLASH_COMMANDS) {
    if (cmd.command === "/clear" && !options.includeLocalClear) continue;
    if (!seen.has(cmd.command)) {
      result.push(cmd);
    }
  }

  return result;
}

const COMPOSER_TOOLBAR_PICKER_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-0";
// The model name is the priority control: it keeps a readable floor and only
// shrinks after the permission/fast labels collapse and the reasoning picker
// has given up its width.
const COMPOSER_MODEL_TRIGGER = "max-w-[min(9.5rem,34vw)] shrink min-w-[4.5rem]";

function ComposerFastModeButton({
  active,
  disabled = false,
  supported,
  onToggle,
}: {
  active: boolean;
  disabled?: boolean;
  supported: boolean;
  onToggle?: (next: boolean) => void;
}) {
  if (!supported) return null;

  return (
    <button
      type="button"
      data-chat-composer-fast-toggle="true"
      aria-label="Fast mode"
      aria-pressed={active}
      title={active ? "Fast mode on" : "Enable fast mode"}
      disabled={disabled || !onToggle}
      onClick={() => onToggle?.(!active)}
      className={cn(
        "ade-chat-composer-fast-toggle inline-flex h-6 shrink-0 items-center justify-center gap-0.5 rounded-md border px-1.5",
        "font-sans text-[9px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45",
        active
          ? "border-amber-300/30 bg-amber-400/12 text-amber-100 shadow-[0_0_0_1px_rgba(251,191,36,0.08)]"
          : "border-white/[0.07] bg-white/[0.025] text-muted-fg/60 hover:bg-white/[0.06] hover:text-fg/80",
      )}
    >
      <Lightning size={10} weight="fill" />
      <span className="ade-chat-composer-fast-label">Fast</span>
    </button>
  );
}

const COMPOSER_PERMISSION_TRIGGER_CLASS = cn(
  "ade-chat-composer-permission-trigger",
  "inline-flex h-6 min-w-0 shrink-0 items-center justify-start gap-1 rounded-md border px-1.5",
  "font-sans text-[length:calc(var(--chat-font-size)*9/14)] leading-none transition-colors duration-150",
  "border-white/[0.06] bg-white/[0.03] text-fg/80",
  "hover:border-violet-400/20 hover:bg-violet-500/[0.06] hover:text-fg",
);

type PermissionModeTone = "green" | "amber" | "blue" | "purple" | "red" | "slate";
type PermissionModeIconKind = "manual" | "auto" | "edit" | "plan" | "full" | "config" | "agent" | "agi";

type PermissionModePickerOption<Value extends string = string> = {
  value: Value;
  label: string;
  triggerLabel?: string;
  detail: string;
  tone: PermissionModeTone;
  icon: PermissionModeIconKind;
};

const PERMISSION_MODE_TONE_STYLES: Record<
  PermissionModeTone,
  {
    dot: string;
    trigger: string;
    iconSurface: string;
    rowActive: string;
    rowHover: string;
  }
> = {
  green: {
    dot: "bg-emerald-400",
    trigger: "border-emerald-400/24 bg-emerald-500/[0.08] text-emerald-100",
    iconSurface: "border-emerald-300/20 bg-emerald-500/[0.12] text-emerald-200",
    rowActive: "bg-emerald-500/[0.12] text-emerald-50",
    rowHover: "hover:bg-emerald-500/[0.08] hover:text-emerald-50",
  },
  amber: {
    dot: "bg-amber-400",
    trigger: "border-amber-300/22 bg-amber-500/[0.08] text-amber-100",
    iconSurface: "border-amber-300/20 bg-amber-500/[0.12] text-amber-200",
    rowActive: "bg-amber-500/[0.12] text-amber-50",
    rowHover: "hover:bg-amber-500/[0.08] hover:text-amber-50",
  },
  blue: {
    dot: "bg-sky-400",
    trigger: "border-sky-300/22 bg-sky-500/[0.08] text-sky-100",
    iconSurface: "border-sky-300/20 bg-sky-500/[0.12] text-sky-200",
    rowActive: "bg-sky-500/[0.12] text-sky-50",
    rowHover: "hover:bg-sky-500/[0.08] hover:text-sky-50",
  },
  purple: {
    dot: "bg-violet-400",
    trigger: "border-violet-300/24 bg-violet-500/[0.09] text-violet-100",
    iconSurface: "border-violet-300/20 bg-violet-500/[0.14] text-violet-200",
    rowActive: "bg-violet-500/[0.14] text-violet-50",
    rowHover: "hover:bg-violet-500/[0.08] hover:text-violet-50",
  },
  red: {
    dot: "bg-red-400",
    trigger: "border-red-300/24 bg-red-500/[0.09] text-red-100",
    iconSurface: "border-red-300/20 bg-red-500/[0.14] text-red-200",
    rowActive: "bg-red-500/[0.14] text-red-50",
    rowHover: "hover:bg-red-500/[0.08] hover:text-red-50",
  },
  slate: {
    dot: "bg-slate-300",
    trigger: "border-white/[0.08] bg-white/[0.045] text-fg/80",
    iconSurface: "border-white/[0.08] bg-white/[0.06] text-fg/72",
    rowActive: "bg-white/[0.08] text-fg/90",
    rowHover: "hover:bg-white/[0.055] hover:text-fg/90",
  },
};

const CLAUDE_MODE_OPTIONS: Array<PermissionModePickerOption<AgentChatClaudePermissionMode>> = [
  { value: "default", label: "Manual", detail: "Claude asks before edits, Bash, and other sensitive tools.", tone: "green", icon: "manual" },
  { value: "auto", label: "Auto", detail: "Claude judges each tool call. Uses a model classifier instead of asking you.", tone: "amber", icon: "auto" },
  { value: "acceptEdits", label: "Accept edits", triggerLabel: "Edits", detail: "File edits are auto-approved; higher-risk actions still prompt.", tone: "amber", icon: "edit" },
  { value: "plan", label: "Plan mode", triggerLabel: "Plan", detail: "Read-only Claude turns for analysis and implementation planning.", tone: "purple", icon: "plan" },
  { value: "bypassPermissions", label: "Bypass", detail: "Skip every Claude permission prompt for this chat.", tone: "red", icon: "full" },
];

function PermissionModeGlyph({
  icon,
  size = 11,
  className,
}: {
  icon: PermissionModeIconKind;
  size?: number;
  className?: string;
}) {
  switch (icon) {
    case "manual":
      return <ShieldCheck size={size} weight="fill" className={className} />;
    case "auto":
      return <Lightning size={size} weight="fill" className={className} />;
    case "edit":
      return <PencilSimple size={size} weight="fill" className={className} />;
    case "plan":
      return <Strategy size={size} weight="fill" className={className} />;
    case "full":
      return <ShieldWarning size={size} weight="fill" className={className} />;
    case "config":
      return <GearSix size={size} weight="fill" className={className} />;
    case "agent":
      return <Desktop size={size} weight="fill" className={className} />;
    case "agi":
      return <RocketLaunch size={size} weight="fill" className={className} />;
  }
}

function PermissionModePicker<Value extends string>({
  ariaLabel,
  selectedValue,
  options,
  disabled,
  onSelect,
  title,
}: {
  ariaLabel: string;
  selectedValue: Value;
  options: Array<PermissionModePickerOption<Value>>;
  disabled?: boolean;
  onSelect?: (value: Value) => void;
  title?: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  const selectedOption = options.find((option) => option.value === selectedValue) ?? options[0];
  const selectedTone = PERMISSION_MODE_TONE_STYLES[selectedOption?.tone ?? "slate"];

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (ref.current?.contains(event.target as Node)) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-permission-mode-picker-dropdown]")) return;
      setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  if (!selectedOption) return null;

  const triggerTitle = title ?? selectedOption.detail;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        data-state={open ? "open" : "closed"}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        disabled={disabled || !onSelect}
        onClick={() => {
          if (disabled || !onSelect) return;
          setOpen((current) => !current);
        }}
        className={cn(
          COMPOSER_PERMISSION_TRIGGER_CLASS,
          selectedTone.trigger,
          open && "ring-1 ring-white/[0.06]",
          (disabled || !onSelect) && "cursor-not-allowed opacity-60 hover:border-white/[0.06] hover:bg-white/[0.03]",
        )}
        title={triggerTitle}
      >
        <span className={cn("inline-flex h-4 w-4 shrink-0 items-center justify-center rounded-full border", selectedTone.iconSurface)} aria-hidden>
          <PermissionModeGlyph icon={selectedOption.icon} size={9} />
        </span>
        <span className="ade-chat-composer-permission-label truncate font-medium leading-none">
          {selectedOption.triggerLabel ?? selectedOption.label}
        </span>
        <CaretDown
          size={10}
          weight="bold"
          className={cn(
            "ade-chat-composer-permission-chevron shrink-0 text-current/65 transition-transform duration-150",
            open && "rotate-180 text-current/90",
          )}
        />
      </button>
      {open && ref.current ? createPortal(
        (() => {
          const rect = ref.current.getBoundingClientRect();
          const width = 284;
          const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8));
          return (
            <div
              role="listbox"
              aria-label={ariaLabel}
              data-permission-mode-picker-dropdown
              className="fixed z-[100] overflow-hidden rounded-xl border border-white/[0.08] bg-[#13111A]/95 shadow-[0_18px_48px_rgba(0,0,0,0.55)] backdrop-blur-md"
              style={{
                left,
                bottom: Math.max(8, window.innerHeight - rect.top + 8),
                width,
              }}
            >
              <div className="flex items-center gap-2 border-b border-white/[0.05] px-3 py-2">
                <span className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border", selectedTone.iconSurface)} aria-hidden>
                  <PermissionModeGlyph icon={selectedOption.icon} size={12} />
                </span>
                <div className="min-w-0">
                  <div className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-[0.18em] text-muted-fg/50">
                    Mode
                  </div>
                  <div className="truncate font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/78">
                    {selectedOption.label}
                  </div>
                </div>
              </div>
              <ul className="py-1">
                {options.map((option) => {
                  const active = option.value === selectedValue;
                  const tone = PERMISSION_MODE_TONE_STYLES[option.tone];
                  return (
                    <li key={option.value}>
                      <button
                        type="button"
                        role="option"
                        aria-label={option.label}
                        aria-selected={active}
                        onClick={() => {
                          onSelect?.(option.value);
                          setOpen(false);
                        }}
                        className={cn(
                          "flex w-full items-center gap-2.5 px-3 py-2 text-left font-sans transition-colors",
                          active ? tone.rowActive : "text-fg/72",
                          tone.rowHover,
                        )}
                        title={option.detail}
                      >
                        <span className={cn("inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-lg border", tone.iconSurface)} aria-hidden>
                          <PermissionModeGlyph icon={option.icon} size={12} />
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[length:calc(var(--chat-font-size)*11/14)] font-semibold leading-4">
                          {option.label}
                        </span>
                        {active ? <Check size={12} weight="bold" className="shrink-0 opacity-80" /> : null}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })(),
        document.body,
      ) : null}
    </div>
  );
}

type CodexPermissionPreset = "default" | "edit" | "plan" | "full-auto" | "config-toml" | "custom";

function resolveCodexPermissionPreset(args: {
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
}): CodexPermissionPreset {
  if (args.codexConfigSource === "config-toml") return "config-toml";
  if (args.codexApprovalPolicy === "untrusted" && args.codexSandbox === "workspace-write") return "edit";
  if ((args.codexApprovalPolicy === "on-request" || args.codexApprovalPolicy === "on-failure") && args.codexSandbox === "workspace-write") return "default";
  if ((args.codexApprovalPolicy === "on-request" || args.codexApprovalPolicy === "untrusted") && args.codexSandbox === "read-only") return "plan";
  if (args.codexApprovalPolicy === "never" && args.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

function codexPermissionPickerOption(option: PermissionOption): PermissionModePickerOption<Exclude<CodexPermissionPreset, "custom">> {
  switch (option.value) {
    case "default":
      return { value: "default", label: option.label, triggerLabel: "Default", detail: option.detail, tone: "green", icon: "manual" };
    case "edit":
      return { value: "edit", label: option.label, triggerLabel: "Edit", detail: option.detail, tone: "amber", icon: "edit" };
    case "plan":
      return { value: "plan", label: option.label, triggerLabel: "Plan", detail: option.detail, tone: "purple", icon: "plan" };
    case "full-auto":
      return { value: "full-auto", label: option.label, triggerLabel: "Full", detail: option.detail, tone: "red", icon: "full" };
    case "config-toml":
      return { value: "config-toml", label: option.label, triggerLabel: "Config", detail: option.detail, tone: "slate", icon: "config" };
    default:
      return { value: "default", label: option.label, triggerLabel: "Default", detail: option.detail, tone: "green", icon: "manual" };
  }
}

function cursorPermissionPickerOption(value: string, label: string): PermissionModePickerOption<string> {
  const normalized = value.trim().toLowerCase();
  if (normalized === "plan") {
    return { value, label, triggerLabel: label, detail: "Read-only planning mode.", tone: "purple", icon: "plan" };
  }
  if (normalized === "ask" || normalized === "edit") {
    return { value, label, triggerLabel: label, detail: "Read-only Q&A mode.", tone: "green", icon: "manual" };
  }
  if (normalized === "full-auto" || normalized === "force" || normalized === "yolo") {
    return { value, label, triggerLabel: label, detail: "Highest access mode for Cursor Agent.", tone: "red", icon: "full" };
  }
  return { value, label, triggerLabel: label, detail: "Cursor Agent's normal approval flow.", tone: "green", icon: "agent" };
}

const OPENCODE_PERMISSION_OPTIONS: Array<PermissionModePickerOption<AgentChatOpenCodePermissionMode>> = [
  { value: "plan", label: "Plan", detail: "Read-only plan agent.", tone: "purple", icon: "plan" },
  { value: "edit", label: "Edit", detail: "Allow edits; ask for the rest.", tone: "amber", icon: "edit" },
  { value: "full-auto", label: "Full auto", detail: "Allow configured OpenCode tools.", tone: "red", icon: "full" },
  { value: "config-toml", label: "Config", detail: "Use OpenCode config files.", tone: "slate", icon: "config" },
];

const DROID_PERMISSION_OPTIONS: Array<PermissionModePickerOption<AgentChatDroidPermissionMode>> = [
  { value: "read-only", label: "Read-only", detail: "No auto flag. Droid stays in read-only mode for analysis and planning.", tone: "green", icon: "manual" },
  { value: "auto-low", label: "Auto low", detail: "Passes --auto low for safe file edits and low-risk operations.", tone: "green", icon: "edit" },
  { value: "auto-medium", label: "Auto medium", detail: "Passes --auto medium for local development operations such as builds, tests, and package installs.", tone: "amber", icon: "auto" },
  { value: "auto-high", label: "Auto high", detail: "Passes --auto high for broad automation. Use only in trusted workspaces.", tone: "red", icon: "full" },
  { value: "agi", label: "AGI (orchestrator)", triggerLabel: "AGI", detail: "Droid decomposes the task into a mission and spawns worker subagents (read-only at the top level). Workers appear in the subagents panel.", tone: "purple", icon: "agi" },
];

function cursorModeLabel(modeId: string): string {
  const normalized = modeId.trim().toLowerCase();
  if (!normalized.length) return "Agent";
  if (CURSOR_MODE_LABELS[normalized]) return CURSOR_MODE_LABELS[normalized];
  return normalized
    .split(/[-_/]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveCursorModeOption(snapshot: AgentChatCursorModeSnapshot | null | undefined): AgentChatCursorConfigOption | null {
  if (!snapshot?.configOptions?.length) return null;
  return snapshot.configOptions.find((option) => option.id === snapshot.modeConfigId || option.category === "mode") ?? null;
}

/** Inline display of a single pending (queued) steer message with cancel and edit controls. */
function PendingSteerItem({
  steer,
  onCancel,
  onEdit,
  onSendNow,
  onInterrupt,
}: {
  steer: { steerId: string; text: string };
  onCancel: () => void;
  onEdit: (text: string) => void;
  onSendNow?: () => void;
  onInterrupt?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(steer.text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  useEffect(() => {
    if (!editing) {
      setEditText(steer.text);
    }
  }, [editing, steer.text]);

  function cancelEdit(): void {
    setEditing(false);
    setEditText(steer.text);
  }

  function commitEdit(): void {
    const trimmed = editText.trim();
    if (!trimmed.length) {
      onCancel();
      return;
    }
    if (trimmed !== steer.text) {
      onEdit(trimmed);
    }
    setEditing(false);
  }

  return (
    <div className="group flex items-start gap-2 rounded-lg border border-[color:color-mix(in_srgb,var(--chat-accent)_16%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_4%,transparent)] px-2.5 py-1.5">
      <div className="mt-px h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--chat-accent)] opacity-60" />
      {editing ? (
        <div className="flex-1 min-w-0">
          <textarea
            ref={inputRef}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                commitEdit();
              } else if (e.key === "Escape") {
                cancelEdit();
              }
            }}
            className="w-full resize-none rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.5] text-fg/82 outline-none focus:border-[var(--chat-accent)]/30"
            rows={1}
          />
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={commitEdit}
              className="inline-flex h-5 items-center gap-0.5 rounded border border-[var(--chat-accent)]/20 bg-[var(--chat-accent)]/8 px-1.5 text-[length:calc(var(--chat-font-size)*9/14)] font-medium text-[var(--chat-accent)] hover:bg-[var(--chat-accent)]/14"
            >
              <Check size={9} weight="bold" /> Save
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="inline-flex h-5 items-center rounded border border-white/[0.06] px-1.5 text-[length:calc(var(--chat-font-size)*9/14)] text-fg/40 hover:text-fg/60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] uppercase tracking-[0.14em] text-[var(--chat-accent)]/60">
            Sends after turn
          </div>
          <div className="truncate text-[length:calc(var(--chat-font-size)*12/14)] leading-[1.5] text-fg/62">
            {steer.text}
          </div>
        </div>
      )}
      {!editing ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          {onSendNow ? (
            <SmartTooltip content={{ label: "Send now", description: "Fold this message into the active turn — Claude picks it up between tool calls." }}>
              <button
                type="button"
                onClick={onSendNow}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/30 hover:bg-[var(--chat-accent)]/12 hover:text-[var(--chat-accent)] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--chat-accent)]/40"
                aria-label="Send now"
              >
                <ArrowBendDownRight size={11} weight="bold" />
              </button>
            </SmartTooltip>
          ) : null}
          {onInterrupt ? (
            <SmartTooltip content={{ label: "Send & interrupt", description: "Stop the current turn and run this message instead." }}>
              <button
                type="button"
                onClick={onInterrupt}
                className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/30 hover:bg-amber-500/12 hover:text-amber-400 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-amber-400/40"
                aria-label="Send and interrupt"
              >
                <Lightning size={11} weight="fill" />
              </button>
            </SmartTooltip>
          ) : null}
          <SmartTooltip content={{ label: "Edit queued message", description: "Change this queued steer message before ADE sends it to the running chat." }}>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/30 hover:bg-white/[0.06] hover:text-fg/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--chat-accent)]/40"
              aria-label="Edit queued message"
            >
              <PencilSimple size={11} />
            </button>
          </SmartTooltip>
          <SmartTooltip content={{ label: "Remove queued message", description: "Remove this steer message from the queue without interrupting the active turn." }}>
            <button
              type="button"
              onClick={onCancel}
              className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/30 hover:bg-red-500/10 hover:text-red-400/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--chat-accent)]/40"
              aria-label="Remove queued message"
            >
              <X size={11} weight="bold" />
            </button>
          </SmartTooltip>
        </div>
      ) : null}
    </div>
  );
}

export function AgentChatComposer({
  surfaceMode = "standard",
  layoutVariant = "standard",
  composerMaxHeightPx = null,
  isActive = false,
  shouldAutofocus = isActive,
  sdkSlashCommands = [],
  modelId,
  availableModelIds,
  constrainModelSelection = false,
  modelUnavailableMessage,
  providerAuthStatus,
  onRuntimeCatalogRefreshed,
  allowCliOnlyModels = false,
  reasoningEffort,
  fastMode = false,
  usageViewModel = null,
  compactionPulse = false,
  draft,
  lastSentUserMessage = null,
  attachments,
  contextAttachments = [],
  allowAttachmentOnlySubmit = false,
  pinnedLinearIssue = null,
  pendingInput,
  approvalResponding,
  turnActive,
  sendOnEnter,
  busy,
  sessionProvider,
  interactionMode,
  claudePermissionMode,
  codexApprovalPolicy,
  codexSandbox,
  codexConfigSource,
  opencodePermissionMode,
  droidPermissionMode,
  cursorModeSnapshot,
  iosElementContextItems = [],
  appControlContextItems = [],
  builtInBrowserContextItems = [],
  modelSelectionLocked = false,
  permissionModeLocked = false,
  hideNativeControls = false,
  orchestrationRole = null,
  messagePlaceholder,
  inputLockMessage,
  onModelChange,
  onReasoningEffortChange,
  onFastModeChange,
  onDraftChange,
  onClearDraft,
  onSubmit,
  onSubmitBlocked,
  onSubmitInBackground,
  backgroundLaunchBusy = false,
  backgroundLaunchLabel = "Background",
  onInterrupt,
  onApproval,
  onAddAttachment,
  onRemoveAttachment,
  onAddContextAttachment,
  onRemoveContextAttachment,
  onSearchAttachments,
  onInteractionModeChange,
  onClaudeModeChange,
  onClaudePermissionModeChange,
  onCodexPresetChange,
  onCodexApprovalPolicyChange,
  onCodexSandboxChange,
  onCodexConfigSourceChange,
  onOpenCodePermissionModeChange,
  onDroidPermissionModeChange,
  onCursorModeChange,
  onCursorConfigChange,
  onRemoveIosElementContext,
  onRemoveAppControlContext,
  onRemoveBuiltInBrowserContext,
  onClearEvents,
  promptSuggestion,
  pendingSteers = [],
  onCancelSteer,
  onEditSteer,
  onDispatchSteerInline,
  onDispatchSteerInterrupt,
  onOpenAiSettings,
  onOpenLinearSettings,
  launchPromptClipboardEnabled = false,
  launchPromptClipboardNoticeEnabled = true,
  onOpenLaunchPromptClipboardSettings,
  onStartOrchestratorChat,
  onStopOrchestratorChat,
  orchestratorModeActive = false,
  sessionId,
  parallelChatMode = false,
  onParallelChatModeChange,
  parallelModelSlots = [],
  parallelConfiguringIndex = null,
  onParallelConfiguringIndexChange,
  onParallelAddModel,
  onParallelRemoveModel,
  onParallelSlotModelChange,
  onParallelSlotReasoningChange,
  onParallelSlotFastModeChange,
  parallelLaunchBusy = false,
  parallelLaunchStatus = null,
  parallelControlSlot = null,
  parallelSlotExecutionModeOptions = [],
  parallelSlotExecutionMode = null,
  onParallelSlotExecutionModeChange,
  showParallelChatToggle = false,
  showIosSimulatorToggle = false,
  iosSimulatorOpen = false,
  onToggleIosSimulator,
  cursorCloudAvailable = false,
  cursorCloudCanLaunch = false,
  cursorCloudAgentId = null,
  cursorCloudPaneOpen = false,
  cursorCloudActiveCount = 0,
  cursorCloudLaunchModeOpen = false,
  cursorCloudLaunchPanel = null,
  onOpenCloudLaunchMode,
  onCloseCloudLaunchMode,
  onOpenCloudBringToLocal,
  onSubmitToCloud,
  showAppControlToggle = false,
  appControlOpen = false,
  onToggleAppControl,
}: {
  surfaceMode?: ChatSurfaceMode;
  layoutVariant?: "standard" | "grid-tile";
  composerMaxHeightPx?: number | null;
  isActive?: boolean;
  shouldAutofocus?: boolean;
  sdkSlashCommands?: AgentChatSlashCommand[];
  modelId: string;
  availableModelIds?: string[];
  constrainModelSelection?: boolean;
  modelUnavailableMessage?: string;
  providerAuthStatus?: Partial<Record<ProviderFamily, AuthStatus>>;
  onRuntimeCatalogRefreshed?: (provider: AgentChatModelCatalogRefreshProvider) => void;
  allowCliOnlyModels?: boolean;
  reasoningEffort: string | null;
  fastMode?: boolean;
  usageViewModel?: ContextUsageViewModel | null;
  compactionPulse?: boolean;
  draft: string;
  /** Last message the user sent in this chat — recalled by ArrowUp on line 1. */
  lastSentUserMessage?: string | null;
  attachments: AgentChatFileRef[];
  contextAttachments?: AgentChatContextAttachment[];
  allowAttachmentOnlySubmit?: boolean;
  pinnedLinearIssue?: LaneLinearIssue | null;
  pendingInput: PendingInputRequest | null;
  approvalResponding?: boolean;
  turnActive: boolean;
  sendOnEnter: boolean;
  busy: boolean;
  sessionProvider?: string;
  interactionMode?: AgentChatInteractionMode | null;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  opencodePermissionMode?: AgentChatOpenCodePermissionMode;
  droidPermissionMode?: AgentChatDroidPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot | null;
  executionMode?: AgentChatExecutionMode | null;
  computerUseSnapshot?: ComputerUseOwnerSnapshot | null;
  iosElementContextItems?: IosElementContextItem[];
  appControlContextItems?: AppControlContextItem[];
  builtInBrowserContextItems?: BuiltInBrowserContextItem[];
  executionModeOptions?: ExecutionModeOption[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
  hideNativeControls?: boolean;
  /**
   * Orchestration role lock (see `goal.md` §10.10).
   *   - `"lead"`: hide permission picker AND model picker once the lead
   *     session exists (lead's model is fixed at create-time).
   *   - `"worker"` / `"validator"`: hide permission picker; show model +
   *     fast + reasoning rows.
   *   - `null` / undefined: default behaviour (regular chat composer).
   *
   * Worker/Validator permission tier is forced by the orchestration spawn
   * profile (`goal.md` §12) — the user should not be able to demote it.
   */
  orchestrationRole?: OrchestrationRole | null;
  messagePlaceholder?: string;
  inputLockMessage?: string | null;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort: string | null) => void;
  onFastModeChange?: (enabled: boolean) => void;
  onDraftChange: (value: string) => void;
  onClearDraft?: () => void;
  onSubmit: () => void;
  onSubmitBlocked?: (message: string) => void;
  onSubmitInBackground?: () => void;
  backgroundLaunchBusy?: boolean;
  backgroundLaunchLabel?: string;
  onInterrupt: () => void;
  onApproval: (
    decision: AgentChatApprovalDecision,
    responseText?: string | null,
    answers?: Record<string, string | string[]>,
  ) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
  onAddContextAttachment?: (attachment: AgentChatContextAttachment) => void;
  onRemoveContextAttachment?: (key: string) => void;
  onSearchAttachments: (query: string) => Promise<AgentChatFileRef[]>;
  onExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  onInteractionModeChange?: (mode: AgentChatInteractionMode) => void;
  onClaudeModeChange?: (mode: AgentChatClaudePermissionMode) => void;
  onClaudePermissionModeChange?: (mode: AgentChatClaudePermissionMode) => void;
  onCodexPresetChange?: (next: {
    codexApprovalPolicy: AgentChatCodexApprovalPolicy;
    codexSandbox: AgentChatCodexSandbox;
    codexConfigSource: AgentChatCodexConfigSource;
  }) => void;
  onCodexApprovalPolicyChange?: (policy: AgentChatCodexApprovalPolicy) => void;
  onCodexSandboxChange?: (sandbox: AgentChatCodexSandbox) => void;
  onCodexConfigSourceChange?: (source: AgentChatCodexConfigSource) => void;
  onOpenCodePermissionModeChange?: (mode: AgentChatOpenCodePermissionMode) => void;
  onDroidPermissionModeChange?: (mode: AgentChatDroidPermissionMode) => void;
  onCursorModeChange?: (modeId: string) => void;
  onCursorConfigChange?: (configId: string, value: string | boolean) => void;
  onComputerUsePolicyChange?: (policy: unknown) => void;
  onRemoveIosElementContext?: (id: string) => void;
  onRemoveAppControlContext?: (id: string) => void;
  onRemoveBuiltInBrowserContext?: (id: string) => void;
  onClearEvents?: () => void;
  promptSuggestion?: string | null;
  chatHasMessages?: boolean;
  pendingSteers?: Array<{ steerId: string; text: string }>;
  onCancelSteer?: (steerId: string) => void;
  onEditSteer?: (steerId: string, text: string) => void;
  onDispatchSteerInline?: (steerId: string) => void;
  onDispatchSteerInterrupt?: (steerId: string) => void;
  onOpenAiSettings?: (family?: ProviderFamily) => void;
  onOpenLinearSettings?: () => void;
  launchPromptClipboardEnabled?: boolean;
  launchPromptClipboardNoticeEnabled?: boolean;
  onOpenLaunchPromptClipboardSettings?: () => void;
  /**
   * Open the "New orchestrator chat" flow from the visible composer mode
   * button (see `goal.md` §10.1). Hosts that don't want the entry simply
   * leave this undefined.
   */
  onStartOrchestratorChat?: () => void;
  onStopOrchestratorChat?: () => void;
  orchestratorModeActive?: boolean;
  sessionId?: string | null;
  parallelChatMode?: boolean;
  onParallelChatModeChange?: (enabled: boolean) => void;
  parallelModelSlots?: Array<{ modelId: string; reasoningEffort: string | null; fastMode?: boolean }>;
  parallelConfiguringIndex?: number | null;
  onParallelConfiguringIndexChange?: (index: number | null) => void;
  onParallelAddModel?: () => void;
  onParallelRemoveModel?: (index: number) => void;
  onParallelSlotModelChange?: (index: number, modelId: string) => void;
  onParallelSlotReasoningChange?: (index: number, effort: string | null) => void;
  onParallelSlotFastModeChange?: (index: number, enabled: boolean) => void;
  parallelLaunchBusy?: boolean;
  parallelLaunchStatus?: string | null;
  parallelControlSlot?: ParallelComposerControlSlot | null;
  parallelSlotExecutionModeOptions?: ExecutionModeOption[];
  parallelSlotExecutionMode?: AgentChatExecutionMode | null;
  onParallelSlotExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  showParallelChatToggle?: boolean;
  showIosSimulatorToggle?: boolean;
  iosSimulatorOpen?: boolean;
  onToggleIosSimulator?: () => void;
  cursorCloudAvailable?: boolean;
  /**
   * Whether the composer can launch a brand-new cloud run from the current chat. Only true for
   * fresh chats with no events and no existing cloud agent — once a chat has any turns, the
   * "Send to Cursor Cloud" affordance hides and the inline launch strip becomes unavailable.
   * The "Open existing cloud chat" menu item is independent and remains visible whenever
   * `cursorCloudAvailable` is true, since it spawns a separate session.
   */
  cursorCloudCanLaunch?: boolean;
  cursorCloudAgentId?: string | null;
  cursorCloudPaneOpen?: boolean;
  cursorCloudActiveCount?: number;
  cursorCloudLaunchModeOpen?: boolean;
  cursorCloudLaunchPanel?: React.ReactNode;
  onOpenCloudLaunchMode?: () => void;
  onCloseCloudLaunchMode?: () => void;
  onOpenCloudBringToLocal?: () => void;
  onSubmitToCloud?: (promptText: string) => Promise<boolean> | boolean;
  showAppControlToggle?: boolean;
  appControlOpen?: boolean;
  onToggleAppControl?: () => void;
}) {
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentResults, setAttachmentResults] = useState<AgentChatFileRef[]>([]);
  const [attachmentCursor, setAttachmentCursor] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);
  const [attachNotice, setAttachNotice] = useState<{ message: string; undoPath: string } | null>(null);
  const [pendingImageAttachments, setPendingImageAttachments] = useState<ChatAttachmentPendingImage[]>([]);
  const [imagePreviewUrls, setImagePreviewUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!attachNotice) return;
    const timer = window.setTimeout(() => setAttachNotice(null), 5000);
    return () => window.clearTimeout(timer);
  }, [attachNotice]);
  const [issueContextMenuOpen, setIssueContextMenuOpen] = useState(false);
  const [linearIssuePickerOpen, setLinearIssuePickerOpen] = useState(false);
  const [selectedIosContextId, setSelectedIosContextId] = useState<string | null>(null);
  const [selectedAppControlContextId, setSelectedAppControlContextId] = useState<string | null>(null);
  const [selectedBuiltInBrowserContextId, setSelectedBuiltInBrowserContextId] = useState<string | null>(null);

  const issueContextButtonRef = useRef<HTMLButtonElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [commandMenuTrigger, setCommandMenuTrigger] = useState<ComposerTrigger | null>(null);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<CommandMenuAnchor | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const attachmentTrayRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const richEditorRef = useRef<HTMLDivElement | null>(null);
  const richSelectionRef = useRef<Range | null>(null);
  const richInitializedRef = useRef(false);
  const lastSerializedDraftRef = useRef<string>("");
  const lastPlainSelectionRef = useRef<number | null>(null);
  const fileAddInProgressRef = useRef(false);
  const objectPreviewUrlsRef = useRef<Set<string>>(new Set());
  const cancelledPendingImageAttachmentsRef = useRef<Set<string>>(new Set());
  const pendingImageAttachmentSequenceRef = useRef(0);
  const previousImagePreviewUrlsRef = useRef<Record<string, string>>({});
  const previousPendingImageAttachmentsRef = useRef<ChatAttachmentPendingImage[]>([]);
  const previousAttachmentPathsRef = useRef<Set<string>>(new Set());
  const clipboardImagePasteHandledRef = useRef(0);
  const clipboardImagePasteFallbackTimerRef = useRef<number | null>(null);
  // Set when the keydown-driven fallback path actually attaches a clipboard
  // image. handlePaste consults this to avoid attaching the same image twice
  // when the real paste event lands after the 80ms fallback has already fired.
  const clipboardImagePasteFallbackAttachedRef = useRef(false);
  // IME composition guard: while composing we keep updating the draft but
  // freeze trigger/menu re-evaluation so half-composed text can't open or
  // retarget the command menu; detection re-runs once on compositionend.
  const imeComposingRef = useRef(false);
  const useRichComposer = iosElementContextItems.length > 0
    || appControlContextItems.length > 0
    || builtInBrowserContextItems.length > 0;
  const externalInputLockMessage = normalizeComposerLabelText(inputLockMessage ?? "");
  const composerInputLocked = Boolean(pendingInput?.blocking) || Boolean(externalInputLockMessage);
  const composerInputLockMessage = externalInputLockMessage || getComposerInputLockMessage(pendingInput);
  const composerInputContextLabel = normalizeComposerLabelText(messagePlaceholder ?? "") || "Chat message";
  const composerInputAccessibleLabel = composerInputLockMessage
    ? `Chat input locked: ${composerInputLockMessage}`
    : turnActive
      ? `Steer active turn: ${composerInputContextLabel}`
      : composerInputContextLabel;
  const attachmentSlotsUsed = attachments.length + pendingImageAttachments.length;
  const canAttach = !composerInputLocked && (!parallelChatMode || attachmentSlotsUsed < PARALLEL_CHAT_MAX_ATTACHMENTS);
  const attachBlockedReason = getAttachBlockedReason({
    composerInputLocked,
    composerInputLockMessage,
    parallelChatMode,
    attachmentCount: attachmentSlotsUsed,
  });
  const contextAttachmentCount = contextAttachments.length;
  const canAttachIssueContext = !composerInputLocked && typeof onAddContextAttachment === "function";
  const showOrchestratorModeButton = Boolean(onStartOrchestratorChat && !sessionId && !parallelChatMode);
  const orchestratorModeButtonDisabled = composerInputLocked || busy || turnActive;
  const showLaunchClipboardNotice =
    launchPromptClipboardEnabled
    && launchPromptClipboardNoticeEnabled
    && !composerInputLocked
    && draft.trim().length > 0;

  // ── Voice dictation ──────────────────────────────────────────────────────
  const voiceInputEnabled = useAppStore((s) => s.voiceInputEnabled);
  const voiceModelInstalled = useVoiceModelInstalled(voiceInputEnabled);
  const [voiceError, setVoiceError] = useState<string | null>(null);
  const [voiceShimmer, setVoiceShimmer] = useState(false);

  const resizeTextarea = useCallback(() => {
    if (useRichComposer) return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const maxH = layoutVariant === "grid-tile" ? (composerMaxHeightPx ?? 200) : 200;
    const next = Math.min(Math.max(el.scrollHeight, 28), maxH);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [layoutVariant, composerMaxHeightPx, useRichComposer]);
  useEffect(() => {
    resizeTextarea();
    if (!shouldAutofocus) return;
    if (useRichComposer) {
      richEditorRef.current?.focus({ preventScroll: true });
      return;
    }
    textareaRef.current?.focus({ preventScroll: true });
  }, [resizeTextarea, shouldAutofocus, useRichComposer]);
  useEffect(() => {
    const objectPreviewUrls = objectPreviewUrlsRef.current;
    return () => {
      if (clipboardImagePasteFallbackTimerRef.current != null) {
        window.clearTimeout(clipboardImagePasteFallbackTimerRef.current);
        clipboardImagePasteFallbackTimerRef.current = null;
      }
      if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        for (const url of objectPreviewUrls) URL.revokeObjectURL(url);
      }
      objectPreviewUrls.clear();
    };
  }, []);
  useEffect(() => {
    if (!composerInputLocked) return;
    setAttachmentPickerOpen(false);
    setIssueContextMenuOpen(false);
    setLinearIssuePickerOpen(false);
    setCommandMenuTrigger(null);
    setDragActive(false);
    if (clipboardImagePasteFallbackTimerRef.current != null) {
      window.clearTimeout(clipboardImagePasteFallbackTimerRef.current);
      clipboardImagePasteFallbackTimerRef.current = null;
    }
    clipboardImagePasteFallbackAttachedRef.current = false;
    for (const attachment of pendingImageAttachments) {
      cancelledPendingImageAttachmentsRef.current.add(attachment.id);
    }
    setPendingImageAttachments((current) => {
      if (!current.length) return current;
      return [];
    });
  }, [composerInputLocked, pendingImageAttachments]);
  useLayoutEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  const attachedPaths = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const effectiveSlashCommands = useMemo(
    () => buildSlashCommands(sdkSlashCommands, { includeLocalClear: typeof onClearEvents === "function" }),
    [sdkSlashCommands, onClearEvents],
  );

  // Confirmed chip tokens in the plain-textarea draft: `@path` tokens whose
  // path is actually attached and `/name` tokens matching a known command.
  // Rendered by a backdrop overlay behind the (then transparent-text)
  // textarea; derived purely from draft + attachments + commands so it
  // survives draft persistence/restore without extra state.
  const knownSlashCommandNames = useMemo(
    () => new Set(effectiveSlashCommands.map((cmd) => cmd.command.replace(/^\//, "").toLowerCase())),
    [effectiveSlashCommands],
  );
  const plainComposerTokens = useMemo(() => {
    if (useRichComposer || !draft) return [];
    return findConfirmedComposerTokens(draft, {
      isFile: (body) => attachedPaths.has(body),
      isCommand: (body) => knownSlashCommandNames.has(body.toLowerCase()),
    });
  }, [attachedPaths, draft, knownSlashCommandNames, useRichComposer]);
  const [plainOverlayScrollTop, setPlainOverlayScrollTop] = useState(0);
  useLayoutEffect(() => {
    if (!plainComposerTokens.length) return;
    setPlainOverlayScrollTop(textareaRef.current?.scrollTop ?? 0);
  }, [draft, plainComposerTokens.length]);
  const plainOverlayContent = useMemo(() => {
    if (!plainComposerTokens.length) return null;
    const segments: React.ReactNode[] = [];
    let pos = 0;
    plainComposerTokens.forEach((token, index) => {
      if (token.start > pos) segments.push(draft.slice(pos, token.start));
      segments.push(
        <span
          key={`chip-${index}-${token.start}`}
          className="rounded-[4px] bg-violet-500/14 text-violet-100/92 shadow-[inset_0_0_0_1px_rgba(167,139,250,0.18)]"
        >
          {draft.slice(token.start, token.end)}
        </span>,
      );
      pos = token.end;
    });
    segments.push(draft.slice(pos));
    // Zero-width terminator keeps a trailing newline's final (empty) line
    // measurable so the overlay height matches the textarea's scrollHeight.
    segments.push("​");
    return segments;
  }, [draft, plainComposerTokens]);

  // Pre-warm the lane's quick-open file index as soon as the composer is
  // bound to a session so the first "@" query is served from a warm index.
  // The empty-query fileSearch is a cheap warm ping: it returns [] right away
  // and kicks the name-index build in the background.
  useEffect(() => {
    if (!sessionId) return;
    try {
      void window.ade?.agentChat?.fileSearch?.({ sessionId, query: "" })?.catch?.(() => {});
    } catch {
      // warming is best-effort
    }
  }, [sessionId]);

  const revokePreviewUrl = useCallback((url: string | null | undefined) => {
    if (!url || !objectPreviewUrlsRef.current.has(url)) return;
    if (typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
      URL.revokeObjectURL(url);
    }
    objectPreviewUrlsRef.current.delete(url);
  }, []);

  const rememberPreviewUrl = useCallback((path: string, url: string | null | undefined) => {
    if (!url) return;
    setImagePreviewUrls((current) => {
      const previous = current[path];
      if (previous === url) return current;
      return { ...current, [path]: url };
    });
  }, []);

  const clearPreviewForPath = useCallback((path: string) => {
    setImagePreviewUrls((current) => {
      if (!current[path]) return current;
      const next = { ...current };
      delete next[path];
      return next;
    });
  }, []);

  const createObjectPreviewUrl = useCallback((file: File): string | null => {
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return null;
    try {
      const url = URL.createObjectURL(file);
      objectPreviewUrlsRef.current.add(url);
      return url;
    } catch {
      return null;
    }
  }, []);

  const addPendingImageAttachment = useCallback((name: string, previewUrl: string | null): ChatAttachmentPendingImage => {
    const pending = {
      id: `pending-image-${Date.now()}-${++pendingImageAttachmentSequenceRef.current}`,
      name,
      previewUrl,
    };
    setPendingImageAttachments((current) => [...current, pending]);
    return pending;
  }, []);

  const dropPendingImageAttachment = useCallback((
    id: string,
    options: { markCancelled?: boolean } = {},
  ) => {
    if (options.markCancelled) cancelledPendingImageAttachmentsRef.current.add(id);
    setPendingImageAttachments((current) => {
      return current.filter((entry) => entry.id !== id);
    });
  }, []);

  const removePendingImageAttachment = useCallback((id: string) => {
    dropPendingImageAttachment(id, { markCancelled: true });
  }, [dropPendingImageAttachment]);

  const handleRemoveAttachment = useCallback((path: string) => {
    clearPreviewForPath(path);
    onRemoveAttachment(path);
  }, [clearPreviewForPath, onRemoveAttachment]);

  const focusComposerInput = useCallback(() => {
    const target = useRichComposer ? richEditorRef.current : textareaRef.current;
    target?.focus({ preventScroll: true });
  }, [useRichComposer]);

  const focusLastImageAttachment = useCallback((): boolean => {
    const targets = Array.from(
      attachmentTrayRef.current?.querySelectorAll<HTMLElement>(CHAT_IMAGE_ATTACHMENT_FOCUS_SELECTOR) ?? [],
    );
    const target = targets.at(-1);
    if (!target) return false;
    target.focus({ preventScroll: true });
    return true;
  }, []);

  useEffect(() => {
    const previous = previousImagePreviewUrlsRef.current;
    for (const [path, previousUrl] of Object.entries(previous)) {
      if (imagePreviewUrls[path] !== previousUrl) {
        revokePreviewUrl(previousUrl);
      }
    }
    previousImagePreviewUrlsRef.current = imagePreviewUrls;
  }, [imagePreviewUrls, revokePreviewUrl]);

  useEffect(() => {
    const currentPendingIds = new Set(pendingImageAttachments.map((attachment) => attachment.id));
    const storedPreviewUrls = new Set(Object.values(imagePreviewUrls));
    for (const attachment of previousPendingImageAttachmentsRef.current) {
      const pendingPreviewUrl = attachment.previewUrl ?? null;
      if (!currentPendingIds.has(attachment.id) && (!pendingPreviewUrl || !storedPreviewUrls.has(pendingPreviewUrl))) {
        revokePreviewUrl(attachment.previewUrl);
      }
    }
    previousPendingImageAttachmentsRef.current = pendingImageAttachments;
  }, [imagePreviewUrls, pendingImageAttachments, revokePreviewUrl]);

  useEffect(() => {
    const currentPaths = new Set(attachments.map((attachment) => attachment.path));
    const previousPaths = previousAttachmentPathsRef.current;
    setImagePreviewUrls((current) => {
      let next = current;
      for (const path of Object.keys(current)) {
        if (!previousPaths.has(path) || currentPaths.has(path)) continue;
        if (next === current) next = { ...current };
        delete next[path];
      }
      return next;
    });
    previousAttachmentPathsRef.current = currentPaths;
  }, [attachments]);

  /* ── Attachment picker effects ── */
  useEffect(() => {
    if (!attachmentPickerOpen) {
      setAttachmentBusy(false);
      setAttachmentQuery("");
      setAttachmentResults([]);
      setAttachmentCursor(0);
      return;
    }
    const timeout = window.setTimeout(() => attachmentInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [attachmentPickerOpen]);

  useEffect(() => {
    setAttachmentCursor((c) => Math.min(c, Math.max(attachmentResults.length - 1, 0)));
  }, [attachmentResults.length]);

  useEffect(() => {
    if (!attachmentPickerOpen) return;
    const query = attachmentQuery.trim();
    if (!query.length) {
      setAttachmentBusy(false);
      setAttachmentResults([]);
      setAttachmentCursor(0);
      return;
    }
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      setAttachmentBusy(true);
      onSearchAttachments(query)
        .then((results) => {
          if (cancelled) return;
          setAttachmentResults(results.filter((r) => !attachedPaths.has(r.path)));
          setAttachmentCursor(0);
        })
        .catch(() => { if (!cancelled) setAttachmentResults([]); })
        .finally(() => { if (!cancelled) setAttachmentBusy(false); });
    }, 120);
    return () => { cancelled = true; window.clearTimeout(timeout); };
  }, [attachmentPickerOpen, attachmentQuery, attachedPaths, onSearchAttachments]);

  const selectAttachment = (attachment: AgentChatFileRef) => {
    setAttachError(null);
    if (parallelChatMode && attachmentSlotsUsed >= PARALLEL_CHAT_MAX_ATTACHMENTS) {
      setAttachError(`You can attach up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files for parallel launch.`);
      return;
    }
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  const addFileAttachments = async (files: FileList | File[] | null | undefined) => {
    if (!files?.length) return;
    if (parallelChatMode && attachmentSlotsUsed >= PARALLEL_CHAT_MAX_ATTACHMENTS) return;
    if (fileAddInProgressRef.current) return;
    fileAddInProgressRef.current = true;
    setAttachError(null);
    try {
      let addedInBatch = 0;
      const initialSlotCount = attachmentSlotsUsed;
      for (const file of Array.from(files)) {
        if (parallelChatMode && initialSlotCount + addedInBatch >= PARALLEL_CHAT_MAX_ATTACHMENTS) {
          setAttachError(`You can attach up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files for parallel launch.`);
          break;
        }
        const fileWithPath = file as File & { path?: string };
        const hasRealPath = typeof fileWithPath.path === "string" && fileWithPath.path.trim().length > 0;
        const attachmentName = file.name || "clipboard.png";
        const isImageAttachment = inferAttachmentType(attachmentName, file.type) === "image";

        if (hasRealPath) {
          const filePath = fileWithPath.path!;
          const attachmentType = inferAttachmentType(filePath, file.type);
          if (attachmentType === "image") {
            const previewUrl = createObjectPreviewUrl(file);
            if (previewUrl) rememberPreviewUrl(filePath, previewUrl);
          }
          onAddAttachment({ path: filePath, type: attachmentType });
          addedInBatch += 1;
          continue;
        }

        if (file.size > MAX_TEMP_ATTACHMENT_BYTES) {
          setAttachError(
            `File "${file.name || "clipboard"}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
          );
          continue;
        }

        const pendingImage = isImageAttachment
          ? addPendingImageAttachment(attachmentName, createObjectPreviewUrl(file))
          : null;
        try {
          const buf = await file.arrayBuffer();
          const base64 = arrayBufferToBase64(buf);
          const { path: tempPath } = await window.ade.agentChat.saveTempAttachment({
            data: base64,
            filename: attachmentName,
          });
          if (pendingImage && cancelledPendingImageAttachmentsRef.current.has(pendingImage.id)) {
            cancelledPendingImageAttachmentsRef.current.delete(pendingImage.id);
            continue;
          }
          const attachmentType = inferAttachmentType(tempPath, file.type);
          const pendingPreviewUrl = pendingImage?.previewUrl ?? null;
          if (attachmentType === "image" && pendingPreviewUrl) {
            rememberPreviewUrl(tempPath, pendingPreviewUrl);
          }
          onAddAttachment({ path: tempPath, type: attachmentType });
          if (pendingImage) {
            dropPendingImageAttachment(pendingImage.id);
          }
          addedInBatch += 1;
        } catch {
          if (pendingImage) dropPendingImageAttachment(pendingImage.id);
          setAttachError(`Unable to attach "${file.name || "clipboard"}".`);
        }
      }
    } finally {
      fileAddInProgressRef.current = false;
    }
  };

  const addNativeClipboardImageAttachment = async () => {
    if (!canAttach) return;
    if (parallelChatMode && attachmentSlotsUsed >= PARALLEL_CHAT_MAX_ATTACHMENTS) return;
    if (fileAddInProgressRef.current) return;
    fileAddInProgressRef.current = true;
    setAttachError(null);
    const pendingImage = addPendingImageAttachment("clipboard.png", null);
    try {
      const image = await window.ade.app.readClipboardImage();
      if (!image) {
        dropPendingImageAttachment(pendingImage.id);
        return;
      }
      const { path: tempPath } = await window.ade.agentChat.saveTempAttachment({
        data: image.data,
        filename: image.filename || "clipboard.png",
      });
      if (cancelledPendingImageAttachmentsRef.current.has(pendingImage.id)) {
        cancelledPendingImageAttachmentsRef.current.delete(pendingImage.id);
        return;
      }
      rememberPreviewUrl(tempPath, `data:${image.mimeType};base64,${image.data}`);
      onAddAttachment({ path: tempPath, type: inferAttachmentType(tempPath, image.mimeType) });
      dropPendingImageAttachment(pendingImage.id);
    } catch {
      dropPendingImageAttachment(pendingImage.id);
      setAttachError("Unable to attach clipboard image.");
    } finally {
      fileAddInProgressRef.current = false;
    }
  };

  const addImageUrlAttachment = useCallback((url: string): boolean => {
    if (!canAttach) return false;
    if (parallelChatMode && attachmentSlotsUsed >= PARALLEL_CHAT_MAX_ATTACHMENTS) {
      setAttachError(`You can attach up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files for parallel launch.`);
      return false;
    }
    setAttachError(null);
    onAddAttachment({ path: url, type: "image-url", url });
    return true;
  }, [attachmentSlotsUsed, canAttach, onAddAttachment, parallelChatMode]);

  const addImageUrlFromTransfer = useCallback((
    data: DataTransfer | React.ClipboardEvent<HTMLElement>["clipboardData"],
    options?: { showNotice?: boolean },
  ): boolean => {
    const url = normalizeImageAttachmentUrl(data.getData("text/uri-list"))
      ?? normalizeImageAttachmentUrl(data.getData("text/plain"));
    if (!url) return false;
    const attached = addImageUrlAttachment(url);
    if (attached && options?.showNotice) {
      setAttachNotice({ message: "Image URL attached", undoPath: url });
    }
    return attached;
  }, [addImageUrlAttachment]);

  const captureRichSelection = useCallback(() => {
    const editor = richEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount) return;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    richSelectionRef.current = range.cloneRange();
  }, []);

  const serializeRichEditor = useCallback((): string => {
    const editor = richEditorRef.current;
    if (!editor) return draft;
    const parts: string[] = [];
    const visit = (node: Node) => {
      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent ?? "");
        return;
      }
      if (!(node instanceof HTMLElement)) return;
      if (node.dataset.composerChipText != null) {
        parts.push(node.dataset.composerChipText);
        return;
      }
      if (
        node.dataset.iosContextId
        || node.dataset.appControlContextId
        || node.dataset.builtInBrowserContextId
      ) {
        parts.push(" ");
        return;
      }
      if (node.tagName === "BR") {
        parts.push("\n");
        return;
      }
      node.childNodes.forEach(visit);
      if (node.tagName === "DIV" || node.tagName === "P") parts.push("\n");
    };
    editor.childNodes.forEach(visit);
    return parts
      .join("")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/[ \t]+\n/g, "\n");
  }, [draft]);

  const syncRichDraft = useCallback(() => {
    if (!useRichComposer) return;
    const editor = richEditorRef.current;
    if (!editor) return;
    onDraftChange(serializeRichEditor());
    captureRichSelection();
  }, [captureRichSelection, onDraftChange, serializeRichEditor, useRichComposer]);

  const getRichCursorTextOffset = useCallback((): number => {
    const editor = richEditorRef.current;
    const selection = window.getSelection();
    if (!editor || !selection || !selection.rangeCount) return serializeRichEditor().length;
    const range = selection.getRangeAt(0);
    if (!editor.contains(range.startContainer)) return serializeRichEditor().length;
    let offset = 0;
    let found = false;
    const visit = (node: Node) => {
      if (found) return;
      if (node === range.startContainer) {
        offset += range.startOffset;
        found = true;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        offset += node.textContent?.length ?? 0;
        return;
      }
      if (
        node instanceof HTMLElement
        && (
          node.dataset.iosContextId
          || node.dataset.appControlContextId
          || node.dataset.builtInBrowserContextId
        )
      ) return;
      node.childNodes.forEach(visit);
    };
    editor.childNodes.forEach(visit);
    return offset;
  }, [serializeRichEditor]);

  const setRichEditorText = useCallback((text: string) => {
    const editor = richEditorRef.current;
    if (!editor) return;
    editor.textContent = text;
    const range = document.createRange();
    range.selectNodeContents(editor);
    range.collapse(false);
    richSelectionRef.current = range.cloneRange();
  }, []);

  const insertTextIntoRichEditor = useCallback((text: string) => {
    const editor = richEditorRef.current;
    if (!editor) return;
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const range = richSelectionRef.current?.cloneRange();
    if (range && editor.contains(range.commonAncestorContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
    document.execCommand("insertText", false, text);
    syncRichDraft();
  }, [syncRichDraft]);

  // Re-evaluate the plain-textarea trigger at the given caret. Typing paths
  // pass openIfNew=true; caret-move paths pass false so cursor movement can
  // close or retarget an open menu but never open one.
  const evaluatePlainTrigger = useCallback((node: HTMLTextAreaElement, caret: number, openIfNew: boolean) => {
    const trigger = detectComposerTrigger(node.value, caret);
    if (!trigger) {
      setCommandMenuTrigger(null);
      return;
    }
    if (!openIfNew) {
      setCommandMenuTrigger((current) => {
        if (!current) return current;
        return trigger.type !== current.type || trigger.start !== current.start || trigger.query !== current.query
          ? trigger
          : current;
      });
      return;
    }
    setCommandMenuTrigger(trigger);
    const anchor = getCommandMenuAnchor(node);
    if (anchor) setCommandMenuAnchor(anchor);
  }, []);

  const restoreTextareaCaret = useCallback((caret: number) => {
    lastPlainSelectionRef.current = caret;
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (!node) return;
      node.focus({ preventScroll: true });
      try {
        node.setSelectionRange(caret, caret);
      } catch {
        // selection may not apply if the node is detached; ignore
      }
      resizeTextarea();
    });
  }, [resizeTextarea]);

  const createComposerTokenChipNode = useCallback((kind: "file" | "command", text: string): HTMLElement => {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.composerChip = kind;
    chip.dataset.composerChipText = text;
    chip.className = "mx-0.5 inline-flex max-w-[280px] translate-y-[1px] items-center rounded-md border border-violet-300/22 bg-violet-500/12 px-1.5 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*12/14)] leading-5 text-violet-100/88 align-baseline";
    chip.title = text;
    const label = document.createElement("span");
    label.className = "truncate";
    label.textContent = text;
    chip.appendChild(label);
    return chip;
  }, []);

  // Finds the in-progress /command or @file token that ends at the caret in
  // the rich contenteditable. Works on the DOM text run around the caret
  // instead of serialized-draft offsets: serialization collapses whitespace
  // and flattens chips, so serialized indices cannot be mapped back onto DOM
  // positions. Chips, <br>, and block edges terminate the run and act as
  // word boundaries.
  const getRichTriggerContext = useCallback((): { trigger: ComposerTrigger; range: Range } | null => {
    const editor = richEditorRef.current;
    if (!editor) return null;
    const selection = window.getSelection();
    if (!selection || !selection.rangeCount) return null;
    const caret = selection.getRangeAt(0);
    if (!caret.collapsed || !editor.contains(caret.startContainer)) return null;

    let caretNode: Text;
    let caretOffset = caret.startOffset;
    if (caret.startContainer.nodeType === Node.TEXT_NODE) {
      caretNode = caret.startContainer as Text;
    } else {
      const prev = caret.startContainer.childNodes[caret.startOffset - 1];
      if (!prev || prev.nodeType !== Node.TEXT_NODE) return null;
      caretNode = prev as Text;
      caretOffset = (caretNode.textContent ?? "").length;
    }

    const runNodes: Text[] = [caretNode];
    let runText = (caretNode.textContent ?? "").slice(0, caretOffset);
    let walker: Node | null = caretNode.previousSibling;
    while (walker && walker.nodeType === Node.TEXT_NODE) {
      runNodes.unshift(walker as Text);
      runText = (walker.textContent ?? "") + runText;
      walker = walker.previousSibling;
    }

    const trigger = detectComposerTrigger(runText, runText.length);
    if (!trigger) return null;

    let remaining = trigger.start;
    let startNode: Text = caretNode;
    let startOffset = caretOffset;
    for (const node of runNodes) {
      const length = node === caretNode ? caretOffset : (node.textContent ?? "").length;
      if (remaining <= length && (node !== caretNode || remaining < caretOffset)) {
        startNode = node;
        startOffset = remaining;
        break;
      }
      remaining -= length;
    }

    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(caretNode, caretOffset);
    return { trigger, range };
  }, []);

  // Replaces the active trigger span in the rich editor with either plain
  // text or a non-editable chip node followed by a space. Returns false when
  // no trigger span can be located (caller falls back to caret insertion).
  const replaceRichTriggerWith = useCallback((insertion: { text: string } | { chipKind: "file" | "command"; chipText: string }): boolean => {
    const editor = richEditorRef.current;
    if (!editor) return false;
    editor.focus({ preventScroll: true });
    const selection = window.getSelection();
    const saved = richSelectionRef.current?.cloneRange();
    if (saved && editor.contains(saved.commonAncestorContainer)) {
      selection?.removeAllRanges();
      selection?.addRange(saved);
    }
    const context = getRichTriggerContext();
    if (!context) return false;
    selection?.removeAllRanges();
    selection?.addRange(context.range);
    if ("text" in insertion) {
      document.execCommand("insertText", false, insertion.text);
      captureRichSelection();
      syncRichDraft();
      return true;
    }
    context.range.deleteContents();
    const chip = createComposerTokenChipNode(insertion.chipKind, insertion.chipText);
    context.range.insertNode(chip);
    const space = document.createTextNode(" ");
    chip.after(space);
    const caretRange = document.createRange();
    caretRange.setStart(space, 1);
    caretRange.collapse(true);
    selection?.removeAllRanges();
    selection?.addRange(caretRange);
    richSelectionRef.current = caretRange.cloneRange();
    syncRichDraft();
    return true;
  }, [captureRichSelection, createComposerTokenChipNode, getRichTriggerContext, syncRichDraft]);

  // Brief shimmer over the composer (CSS honors prefers-reduced-motion). Fired
  // both on the optimistic mic-down (recording start) and on transcript insert.
  const voiceShimmerTimerRef = useRef<number | null>(null);
  const triggerVoiceShimmer = useCallback(() => {
    ensureVoiceShimmerStyles();
    setVoiceShimmer(false);
    // Re-arm on the next frame so a back-to-back trigger restarts the sweep.
    requestAnimationFrame(() => {
      setVoiceShimmer(true);
      if (voiceShimmerTimerRef.current != null) {
        window.clearTimeout(voiceShimmerTimerRef.current);
      }
      voiceShimmerTimerRef.current = window.setTimeout(() => setVoiceShimmer(false), 1000);
    });
  }, []);
  useEffect(() => () => {
    if (voiceShimmerTimerRef.current != null) {
      window.clearTimeout(voiceShimmerTimerRef.current);
    }
  }, []);

  // Insert dictated text at the current caret without destroying existing text.
  // Handles both the plain textarea and the contenteditable rich editor.
  const insertDictatedText = useCallback((text: string) => {
    const insertion = text.trim();
    if (!insertion) return;
    setVoiceError(null);
    if (useRichComposer) {
      // Rich editor: insert at the saved selection range (or end), then sync draft.
      insertTextIntoRichEditor(insertion);
    } else {
      const current = draft;
      const caret = lastPlainSelectionRef.current ?? current.length;
      const start = Math.max(0, Math.min(caret, current.length));
      const before = current.slice(0, start);
      const after = current.slice(start);
      // Add a separating space when butting up against existing words.
      const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
      const needsTrailingSpace = after.length > 0 && !/^\s/.test(after);
      const piece = `${needsLeadingSpace ? " " : ""}${insertion}${needsTrailingSpace ? " " : ""}`;
      const next = `${before}${piece}${after}`;
      onDraftChange(next);
      const nextCaret = before.length + piece.length;
      lastPlainSelectionRef.current = nextCaret;
      // Restore focus + caret after React applies the new value.
      requestAnimationFrame(() => {
        const node = textareaRef.current;
        if (!node) return;
        node.focus({ preventScroll: true });
        try {
          node.setSelectionRange(nextCaret, nextCaret);
        } catch {
          // selection may not apply if the node is detached; ignore
        }
        resizeTextarea();
      });
    }
    // Brief shimmer over the insert (CSS honors prefers-reduced-motion).
    triggerVoiceShimmer();
  }, [draft, insertTextIntoRichEditor, onDraftChange, resizeTextarea, triggerVoiceShimmer, useRichComposer]);

  // ── App-global dictation target registration ─────────────────────────────
  // Register this composer as the active dictation target so the app-global
  // recorder (which writes to the ROOT store and survives this component
  // unmounting / navigation) inserts the cleaned transcript here. We keep the
  // registered functions in refs so a single stable target object can be
  // (re)registered on focus without re-running on every callback identity change.
  const dictationTargetId = useId();
  const insertDictatedTextRef = useRef(insertDictatedText);
  const focusComposerInputRef = useRef(focusComposerInput);
  insertDictatedTextRef.current = insertDictatedText;
  focusComposerInputRef.current = focusComposerInput;
  const registerAsDictationTarget = useCallback(() => {
    rootAppStoreApi.getState().registerDictationTarget({
      id: dictationTargetId,
      insertText: (text: string) => insertDictatedTextRef.current(text),
      focus: () => focusComposerInputRef.current(),
    });
  }, [dictationTargetId]);
  useEffect(() => {
    // Claim the target on mount (and whenever the composer becomes active), and
    // release it on unmount ONLY if we're still the registered target — a newer
    // composer that focused after us must not be clobbered by our teardown.
    if (isActive) registerAsDictationTarget();
    return () => {
      rootAppStoreApi.getState().unregisterDictationTarget(dictationTargetId);
    };
  }, [dictationTargetId, isActive, registerAsDictationTarget]);

  const insertNodeAtTextOffset = useCallback((editor: HTMLElement, node: Node, offset: number) => {
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    let remaining = Math.max(0, offset);
    while (current) {
      const length = current.textContent?.length ?? 0;
      if (remaining <= length) {
        const range = document.createRange();
        range.setStart(current, remaining);
        range.collapse(true);
        range.insertNode(node);
        return;
      }
      remaining -= length;
      current = walker.nextNode();
    }
    editor.appendChild(node);
  }, []);

  const createIosContextChipNode = useCallback((item: IosElementContextItem): HTMLElement => {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.iosContextId = item.id;
    chip.className = "mx-0.5 inline-flex max-w-[260px] translate-y-[1px] items-center gap-1.5 rounded-md border border-cyan-300/22 bg-cyan-500/12 px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-5 text-cyan-50/85 align-baseline";
    chip.title = item.sourceFile ? `${iosContextDisplayLabel(item)} - ${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}` : iosContextDisplayLabel(item);

    const label = document.createElement("span");
    label.className = "max-w-[150px] truncate";
    label.textContent = iosContextDisplayLabel(item);
    chip.appendChild(label);

    const source = document.createElement("span");
    source.className = "max-w-[90px] truncate text-cyan-100/45";
    source.textContent = iosContextSourceDescription(item);
    chip.appendChild(source);

    const remove = document.createElement("span");
    remove.className = "rounded px-0.5 text-cyan-100/45";
    remove.textContent = "x";
    remove.dataset.iosRemove = "true";
    chip.appendChild(remove);
    return chip;
  }, []);

  const createAppControlContextChipNode = useCallback((item: AppControlContextItem): HTMLElement => {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.appControlContextId = item.id;
    chip.className = "mx-0.5 inline-flex max-w-[260px] translate-y-[1px] items-center gap-1.5 rounded-md border border-sky-300/22 bg-sky-500/12 px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-5 text-sky-50/85 align-baseline";
    chip.title = item.sourceFile
      ? `${appControlContextDisplayLabel(item)} - ${item.sourceFile}${item.sourceLine ? `:${item.sourceLine}` : ""}`
      : appControlContextDisplayLabel(item);

    const label = document.createElement("span");
    label.className = "max-w-[150px] truncate";
    label.textContent = appControlContextDisplayLabel(item);
    chip.appendChild(label);

    const source = document.createElement("span");
    source.className = "max-w-[90px] truncate text-sky-100/45";
    source.textContent = appControlContextSourceDescription(item);
    chip.appendChild(source);

    const remove = document.createElement("span");
    remove.className = "rounded px-0.5 text-sky-100/45";
    remove.textContent = "x";
    remove.dataset.appControlRemove = "true";
    chip.appendChild(remove);
    return chip;
  }, []);

  const createBuiltInBrowserContextChipNode = useCallback((item: BuiltInBrowserContextItem): HTMLElement => {
    const chip = document.createElement("span");
    chip.contentEditable = "false";
    chip.dataset.builtInBrowserContextId = item.id;
    chip.className = "mx-0.5 inline-flex max-w-[260px] translate-y-[1px] items-center gap-1.5 rounded-md border border-teal-300/22 bg-teal-500/12 px-2 py-0.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-5 text-teal-50/85 align-baseline";
    chip.title = `${builtInBrowserContextDisplayLabel(item)} - ${builtInBrowserContextSourceDescription(item)}`;

    const label = document.createElement("span");
    label.className = "max-w-[150px] truncate";
    label.textContent = builtInBrowserContextDisplayLabel(item);
    chip.appendChild(label);

    const source = document.createElement("span");
    source.className = "max-w-[90px] truncate text-teal-100/45";
    source.textContent = builtInBrowserContextSourceDescription(item);
    chip.appendChild(source);

    const remove = document.createElement("span");
    remove.className = "rounded px-0.5 text-teal-100/45";
    remove.textContent = "x";
    remove.dataset.builtInBrowserRemove = "true";
    chip.appendChild(remove);
    return chip;
  }, []);

  useLayoutEffect(() => {
    const editor = richEditorRef.current;
    if (!useRichComposer || !editor) {
      richInitializedRef.current = false;
      return;
    }
    if (!richInitializedRef.current) {
      editor.textContent = draft;
      richInitializedRef.current = true;
    }

    const isFocusedInsideEditor = document.activeElement === editor;
    const insertChipFragment = (chip: HTMLElement) => {
      const before = document.createTextNode(" ");
      const after = document.createTextNode(" ");
      const fragment = document.createDocumentFragment();
      fragment.append(before, chip, after);
      const savedRange = richSelectionRef.current;
      // Prefer cursor insertion only when the user is actually typing in the
      // editor — otherwise (chips arriving from an external panel like
      // App Control or iOS sim) just append to the end, which makes
      // multi-chip ordering deterministic.
      if (isFocusedInsideEditor && savedRange && editor.contains(savedRange.commonAncestorContainer)) {
        const range = savedRange.cloneRange();
        range.deleteContents();
        range.insertNode(fragment);
        range.setStartAfter(after);
        range.collapse(true);
        richSelectionRef.current = range.cloneRange();
        return;
      }
      editor.appendChild(fragment);
      const range = document.createRange();
      range.setStartAfter(after);
      range.collapse(true);
      richSelectionRef.current = range.cloneRange();
    };

    const iosIds = new Set(iosElementContextItems.map((item) => item.id));
    editor.querySelectorAll<HTMLElement>("[data-ios-context-id]").forEach((node) => {
      const id = node.dataset.iosContextId;
      if (!id || !iosIds.has(id)) node.remove();
    });
    const existingIosIds = new Set(Array.from(editor.querySelectorAll<HTMLElement>("[data-ios-context-id]")).map((node) => node.dataset.iosContextId).filter(Boolean));
    for (const item of iosElementContextItems) {
      if (existingIosIds.has(item.id)) continue;
      insertChipFragment(createIosContextChipNode(item));
      existingIosIds.add(item.id);
    }

    const appControlIds = new Set(appControlContextItems.map((item) => item.id));
    editor.querySelectorAll<HTMLElement>("[data-app-control-context-id]").forEach((node) => {
      const id = node.dataset.appControlContextId;
      if (!id || !appControlIds.has(id)) node.remove();
    });
    const existingAppControlIds = new Set(
      Array.from(editor.querySelectorAll<HTMLElement>("[data-app-control-context-id]"))
        .map((node) => node.dataset.appControlContextId)
        .filter(Boolean),
    );
    for (const item of appControlContextItems) {
      if (existingAppControlIds.has(item.id)) continue;
      insertChipFragment(createAppControlContextChipNode(item));
      existingAppControlIds.add(item.id);
    }

    const builtInBrowserIds = new Set(builtInBrowserContextItems.map((item) => item.id));
    editor.querySelectorAll<HTMLElement>("[data-built-in-browser-context-id]").forEach((node) => {
      const id = node.dataset.builtInBrowserContextId;
      if (!id || !builtInBrowserIds.has(id)) node.remove();
    });
    const existingBuiltInBrowserIds = new Set(
      Array.from(editor.querySelectorAll<HTMLElement>("[data-built-in-browser-context-id]"))
        .map((node) => node.dataset.builtInBrowserContextId)
        .filter(Boolean),
    );
    for (const item of builtInBrowserContextItems) {
      if (existingBuiltInBrowserIds.has(item.id)) continue;
      insertChipFragment(createBuiltInBrowserContextChipNode(item));
      existingBuiltInBrowserIds.add(item.id);
    }

    const next = serializeRichEditor();
    if (next === lastSerializedDraftRef.current) return;
    lastSerializedDraftRef.current = next;
    onDraftChange(next);
  }, [appControlContextItems, builtInBrowserContextItems, createAppControlContextChipNode, createBuiltInBrowserContextChipNode, createIosContextChipNode, draft, insertNodeAtTextOffset, iosElementContextItems, onDraftChange, serializeRichEditor, useRichComposer]);

  const handleSlashSelect = useCallback((cmd: SlashCommandEntry) => {
    // Local-only commands handled client-side
    if (cmd.command === "/clear" && cmd.source === "local" && onClearEvents) { onClearEvents(); onDraftChange(""); return; }
    // SDK and all other commands: set as draft text to be sent to the agent
    const suffix = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
    const next = `${cmd.command}${suffix} `;
    if (useRichComposer) setRichEditorText(next);
    onDraftChange(next);
  }, [onClearEvents, onDraftChange, setRichEditorText, useRichComposer]);

  const nativeControlsDisabled = permissionModeLocked;
  const slot = parallelControlSlot;
  const sp = slot?.sessionProvider ?? sessionProvider ?? "opencode";
  const im = slot?.interactionMode ?? interactionMode ?? "default";
  const cpmUse = slot?.claudePermissionMode ?? claudePermissionMode;
  const capUse = slot?.codexApprovalPolicy ?? codexApprovalPolicy;
  const csUse = slot?.codexSandbox ?? codexSandbox;
  const ccsUse = slot?.codexConfigSource ?? codexConfigSource;
  const opmUse = slot?.opencodePermissionMode ?? opencodePermissionMode;
  const dpmUse = slot?.droidPermissionMode ?? droidPermissionMode ?? "auto-low";
  const cmsUse = slot?.cursorModeSnapshot ?? cursorModeSnapshot;
  const fastModeModelId =
    parallelChatMode && parallelConfiguringIndex != null
      ? (parallelModelSlots[parallelConfiguringIndex]?.modelId ?? "")
      : (modelId ?? "");
  const fastModeSupported = modelSupportsFastMode(
    resolveModelDescriptorWithRuntimeCatalog(fastModeModelId) ?? getModelById(fastModeModelId),
  );
  const fastModeActive =
    parallelChatMode && parallelConfiguringIndex != null
      ? parallelModelSlots[parallelConfiguringIndex]?.fastMode === true
      : fastMode === true;

  const claudeSelectionMode = cpmUse === "plan" || im === "plan"
    ? "plan"
    : cpmUse ?? "default";
  const codexPreset = resolveCodexPermissionPreset({
    codexApprovalPolicy: capUse,
    codexSandbox: csUse,
    codexConfigSource: ccsUse,
  });
  const codexPresetOptions = useMemo(
    () => getPermissionOptions({ family: "openai", isCliWrapped: true })
      .filter((option) => option.value === "default" || option.value === "edit" || option.value === "plan" || option.value === "full-auto" || option.value === "config-toml"),
    [],
  );
  const applyCodexPreset = useCallback((preset: Exclude<CodexPermissionPreset, "custom">) => {
    let next: {
      codexApprovalPolicy: AgentChatCodexApprovalPolicy;
      codexSandbox: AgentChatCodexSandbox;
      codexConfigSource: AgentChatCodexConfigSource;
    };
    switch (preset) {
      case "default":
        next = {
          codexApprovalPolicy: "on-request",
          codexSandbox: "workspace-write",
          codexConfigSource: "flags",
        };
        break;
      case "plan":
        next = {
          codexApprovalPolicy: "on-request",
          codexSandbox: "read-only",
          codexConfigSource: "flags",
        };
        break;
      case "edit":
        next = {
          codexApprovalPolicy: "untrusted",
          codexSandbox: "workspace-write",
          codexConfigSource: "flags",
        };
        break;
      case "config-toml":
        next = {
          codexApprovalPolicy: codexApprovalPolicy ?? "on-request",
          codexSandbox: codexSandbox ?? "workspace-write",
          codexConfigSource: "config-toml",
        };
        break;
      default:
        next = {
          codexApprovalPolicy: "never",
          codexSandbox: "danger-full-access",
          codexConfigSource: "flags",
        };
        break;
    }

    if (parallelControlSlot) {
      parallelControlSlot.onCodexPresetChange(next);
      return;
    }
    if (onCodexPresetChange) {
      onCodexPresetChange(next);
      return;
    }
    onCodexConfigSourceChange?.(next.codexConfigSource);
    onCodexApprovalPolicyChange?.(next.codexApprovalPolicy);
    onCodexSandboxChange?.(next.codexSandbox);
  }, [
    codexApprovalPolicy,
    codexSandbox,
    onCodexApprovalPolicyChange,
    onCodexConfigSourceChange,
    onCodexPresetChange,
    onCodexSandboxChange,
    parallelControlSlot,
  ]);
  useEffect(() => {
    if (!issueContextMenuOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (issueContextButtonRef.current?.contains(event.target as Node)) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-issue-context-menu]")) return;
      setIssueContextMenuOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setIssueContextMenuOpen(false);
      }
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [issueContextMenuOpen]);

  const codexCustomSummary = useMemo(() => {
    if (sp !== "codex" || codexPreset !== "custom") return null;
    if (ccsUse === "config-toml") {
      return "Custom Codex mode: config.toml controls approval and sandbox.";
    }
    const approvalLabel = {
      "untrusted": "Untrusted",
      "on-request": "On request",
      "on-failure": "On failure (legacy)",
      "never": "Never",
    }[capUse ?? "on-request"];
    const sandboxLabel = {
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Danger full access",
    }[csUse ?? "workspace-write"];
    return `Custom Codex mode: ${ccsUse === "flags" ? "ADE flags" : "config.toml"} - ${approvalLabel} - ${sandboxLabel}`;
  }, [capUse, ccsUse, codexPreset, csUse, sp]);
  const nativeControlPanel = useMemo(() => {
    if (hideNativeControls) {
      return null;
    }
    // Orchestration-locked composers (lead / worker / validator) hide the
    // native permission picker — the orchestrator forces the permission
    // tier per `goal.md` §10.10 + §12.
    if (orchestrationRole) {
      return null;
    }
    const effectiveModelId =
      parallelChatMode && parallelConfiguringIndex != null
        ? (parallelModelSlots[parallelConfiguringIndex]?.modelId ?? "")
        : (modelId ?? "");
    if (!effectiveModelId.trim()) {
      return null;
    }
    const plainComposerToolbarChrome = !parallelChatMode;

    if (sp === "claude") {
      const selectedOption =
        CLAUDE_MODE_OPTIONS.find((option) => option.value === claudeSelectionMode) ?? CLAUDE_MODE_OPTIONS[0];
      const applyClaudeMode = (mode: AgentChatClaudePermissionMode) => {
        if (parallelControlSlot) {
          if (mode === "plan") {
            parallelControlSlot.onInteractionModeChange("plan");
            parallelControlSlot.onClaudePermissionModeChange("plan");
            return;
          }
          parallelControlSlot.onInteractionModeChange("default");
          parallelControlSlot.onClaudePermissionModeChange(mode);
          return;
        }
        if (onClaudeModeChange) {
          onClaudeModeChange(mode);
          return;
        }
        if (mode === "plan") {
          onInteractionModeChange?.("plan");
          onClaudePermissionModeChange?.("plan");
          return;
        }
        onInteractionModeChange?.("default");
        onClaudePermissionModeChange?.(mode);
      };
      return (
        <div className={cn("flex flex-wrap gap-2", plainComposerToolbarChrome ? "items-center" : "items-start")}>
          <PermissionModePicker
            ariaLabel="Claude permission mode"
            selectedValue={selectedOption.value}
            options={CLAUDE_MODE_OPTIONS}
            disabled={nativeControlsDisabled}
            onSelect={applyClaudeMode}
          />
        </div>
      );
    }

    if (sp === "codex") {
      const codexModeOptions = codexPresetOptions.map(codexPermissionPickerOption);
      const codexCustomOption: PermissionModePickerOption<CodexPermissionPreset> = {
        value: "custom",
        label: "Custom",
        detail: codexCustomSummary ?? "Custom Codex approval/sandbox combination.",
        tone: "slate",
        icon: "config",
      };
      const pickerOptions: Array<PermissionModePickerOption<CodexPermissionPreset>> = codexPreset === "custom"
        ? [...codexModeOptions, codexCustomOption]
        : codexModeOptions;
      return (
        <PermissionModePicker
          ariaLabel="Codex permission mode"
          selectedValue={codexPreset}
          options={pickerOptions}
          disabled={nativeControlsDisabled}
          onSelect={(preset) => {
            if (preset === "custom") return;
            applyCodexPreset(preset);
          }}
          title={pickerOptions.find((option) => option.value === codexPreset)?.detail ?? codexCustomSummary ?? "Codex permission mode"}
        />
      );
    }

    if (sp === "droid") {
      return (
        <PermissionModePicker
          ariaLabel="Droid autonomy mode"
          selectedValue={dpmUse}
          options={DROID_PERMISSION_OPTIONS}
          disabled={nativeControlsDisabled || (!onDroidPermissionModeChange && !parallelControlSlot)}
          onSelect={(value) => {
            if (parallelControlSlot) parallelControlSlot.onDroidPermissionModeChange(value);
            else onDroidPermissionModeChange?.(value);
          }}
        />
      );
    }

    const cursorModeOption = resolveCursorModeOption(cmsUse);
    const cursorExtraOptions = (cmsUse?.configOptions ?? []).filter((option) => {
      if (option.id === cmsUse?.modelConfigId) return false;
      if (option.id === cursorModeOption?.id) return false;
      return true;
    });

    if (sp === "cursor" && (cmsUse?.availableModeIds?.length || cursorModeOption)) {
      const modeValue = typeof cursorModeOption?.currentValue === "string"
        ? cursorModeOption.currentValue
        : cmsUse?.currentModeId ?? "";
      const modeChoices = cursorModeOption?.options?.length
        ? cursorModeOption.options.map((option) => ({ value: option.value, label: option.label }))
        : (cmsUse?.availableModeIds ?? []).map((modeId) => ({
            value: modeId,
            label: cursorModeLabel(modeId),
          }));
      const cursorModeOptions = modeChoices.map((option) => cursorPermissionPickerOption(option.value, option.label));
      return (
        <div className="flex flex-wrap items-center gap-2">
          {modeChoices.length ? (
            <PermissionModePicker
              ariaLabel="Cursor mode"
              selectedValue={modeValue || cursorModeOptions[0]?.value || ""}
              options={cursorModeOptions}
              disabled={nativeControlsDisabled || (!onCursorModeChange && !parallelControlSlot)}
              onSelect={(value) => {
                if (parallelControlSlot) parallelControlSlot.onCursorModeChange(value);
                else onCursorModeChange?.(value);
              }}
            />
          ) : null}
          {cursorExtraOptions.map((option) => {
            if (option.type === "boolean") {
              const active = option.currentValue === true;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={nativeControlsDisabled || (!onCursorConfigChange && !parallelControlSlot)}
                  onClick={() => {
                    if (parallelControlSlot) parallelControlSlot.onCursorConfigChange(option.id, !active);
                    else onCursorConfigChange?.(option.id, !active);
                  }}
                  className={cn(
                    "inline-flex h-8 min-h-8 items-center gap-2 rounded-md px-2 font-sans text-[length:calc(var(--chat-font-size)*11/14)] transition-colors",
                    plainComposerToolbarChrome
                      ? cn(
                          "border border-transparent bg-transparent",
                          active ? "text-emerald-200/90" : "text-fg/72",
                          nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "hover:bg-white/[0.05] hover:text-fg/86",
                        )
                      : cn(
                          "border px-2.5 py-1.5",
                          active
                            ? "border-emerald-500/24 bg-emerald-500/[0.10] text-emerald-100/88"
                            : "border-white/[0.06] bg-[#1a1a22] text-fg/72",
                          nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "hover:border-white/[0.1] hover:text-fg/86",
                        ),
                  )}
                  title={option.description ?? option.name}
                  aria-pressed={active}
                >
                  <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] uppercase tracking-[0.12em] text-muted-fg/45">
                    {active ? "On" : "Off"}
                  </span>
                  <span>{option.name}</span>
                </button>
              );
            }

            const choices = option.options ?? [];
            if (!choices.length) return null;
            return (
              <label
                key={option.id}
                className={cn(
                  "flex h-8 min-h-8 items-center gap-2 rounded-md px-2",
                  plainComposerToolbarChrome
                    ? "border border-transparent bg-transparent"
                    : "border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5",
                )}
                title={option.description ?? option.name}
              >
                <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] uppercase tracking-[0.16em] text-muted-fg/45">
                  {option.name}
                </span>
                <select
                  value={typeof option.currentValue === "string" ? option.currentValue : ""}
                  disabled={nativeControlsDisabled || (!onCursorConfigChange && !parallelControlSlot)}
                  onChange={(event) => {
                    if (parallelControlSlot) parallelControlSlot.onCursorConfigChange(option.id, event.target.value);
                    else onCursorConfigChange?.(option.id, event.target.value);
                  }}
                  className="min-w-0 bg-transparent font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
                >
                  {choices.map((choice) => (
                    <option key={`${option.id}:${choice.value}`} value={choice.value}>
                      {choice.label}
                    </option>
                  ))}
                </select>
              </label>
            );
          })}
        </div>
      );
    }

    return (
      <PermissionModePicker
        ariaLabel="OpenCode permission mode"
        selectedValue={opmUse ?? "edit"}
        options={OPENCODE_PERMISSION_OPTIONS}
        disabled={nativeControlsDisabled || (!onOpenCodePermissionModeChange && !parallelControlSlot)}
        onSelect={(value) => {
          if (parallelControlSlot) parallelControlSlot.onOpenCodePermissionModeChange(value);
          else onOpenCodePermissionModeChange?.(value);
        }}
      />
    );
  }, [
    claudeSelectionMode,
    applyCodexPreset,
    codexPreset,
    codexPresetOptions,
    codexCustomSummary,
    nativeControlsDisabled,
    hideNativeControls,
    orchestrationRole,
    onClaudeModeChange,
    onClaudePermissionModeChange,
    onInteractionModeChange,
    onCursorConfigChange,
    onCursorModeChange,
    onDroidPermissionModeChange,
    onOpenCodePermissionModeChange,
    cmsUse,
    dpmUse,
    sp,
    opmUse,
    parallelControlSlot,
    modelId,
    parallelChatMode,
    parallelConfiguringIndex,
    parallelModelSlots,
  ]);

  // Clean composer: no provider-tinted glow border (that produced the bright
  // "highlighted" outline). Only the orchestrator's special mode keeps a glow.
  const composerGlowColor = useMemo(() => {
    return orchestratorModeActive ? "rgba(217, 70, 239, 0.36)" : null;
  }, [orchestratorModeActive]);

  /* ── Keyboard handler for composer input ── */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const commandModified = event.metaKey || event.ctrlKey;
    if (composerInputLocked) {
      if (event.key === "Escape" && pendingInput) {
        event.preventDefault();
        onApproval("cancel");
      }
      return;
    }
    if (isMacPasteShortcut(event)) {
      const handledPasteGeneration = clipboardImagePasteHandledRef.current;
      if (clipboardImagePasteFallbackTimerRef.current != null) {
        window.clearTimeout(clipboardImagePasteFallbackTimerRef.current);
      }
      clipboardImagePasteFallbackAttachedRef.current = false;
      clipboardImagePasteFallbackTimerRef.current = window.setTimeout(() => {
        clipboardImagePasteFallbackTimerRef.current = null;
        if (clipboardImagePasteHandledRef.current !== handledPasteGeneration) return;
        // Claim the generation before attaching so a real paste event landing
        // after this fallback fires short-circuits in handlePaste instead of
        // attaching the same clipboard image a second time.
        clipboardImagePasteHandledRef.current += 1;
        clipboardImagePasteFallbackAttachedRef.current = true;
        void addNativeClipboardImageAttachment();
      }, CLIPBOARD_IMAGE_PASTE_FALLBACK_DELAY_MS);
    }

    /* Command menu keyboard navigation */
    if (commandMenuTrigger) {
      if (event.key === "Escape") { event.preventDefault(); setCommandMenuTrigger(null); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); commandMenuRef.current?.moveDown(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); commandMenuRef.current?.moveUp(); return; }
      if (event.key === "Enter" || event.key === "Tab") {
        if (commandMenuRef.current?.selectCurrent()) { event.preventDefault(); return; }
        // No matching row (e.g. "check /tmp"): close the menu and let
        // Enter/Tab fall through to their normal send/suggestion behavior.
        setCommandMenuTrigger(null);
      }
    }

    if (event.key === "ArrowUp" && !commandModified && !event.shiftKey && !event.altKey) {
      const target = event.currentTarget;
      const atPromptStart = target instanceof HTMLTextAreaElement
        ? target.selectionStart === 0 && target.selectionEnd === 0
        : getRichCursorTextOffset() === 0;
      if (atPromptStart && focusLastImageAttachment()) {
        event.preventDefault();
        return;
      }
      // Terminal-style recall: ArrowUp on the first line fills the last message
      // you sent (so you can re-run or tweak it). Skipped for multi-line drafts
      // (so ArrowUp still navigates between lines) and when nothing was sent yet.
      if (target instanceof HTMLTextAreaElement) {
        const recall = lastSentUserMessage?.trim() ?? "";
        const isMultiLine = target.value.indexOf("\n") !== -1;
        const onFirstLine = target.selectionStart === target.selectionEnd
          && target.value.slice(0, target.selectionStart).indexOf("\n") === -1;
        if (recall && !isMultiLine && onFirstLine && recall !== draft) {
          event.preventDefault();
          onDraftChange(recall);
          requestAnimationFrame(() => {
            const el = textareaRef.current;
            if (el) {
              el.focus({ preventScroll: true });
              el.selectionStart = el.selectionEnd = el.value.length;
            }
          });
          return;
        }
      }
    }

    if (event.key === "@" && !commandModified && !event.altKey) {
      if (!canAttach) return;
      // Let @ be typed into textarea; onChange will detect the trigger
      return;
    }

    if (event.key === "Escape") {
      event.preventDefault();
      if (attachmentPickerOpen) { setAttachmentPickerOpen(false); return; }
      if (pendingInput) { onApproval("cancel"); return; }
      if (draft.length) { onDraftChange(""); }
      return;
    }

    if (event.key === "." && commandModified && turnActive) { event.preventDefault(); onInterrupt(); return; }

    /* Tab to accept prompt suggestion */
    if (event.key === "Tab" && !event.shiftKey && !commandModified && promptSuggestion && !draft.length && !turnActive) {
      event.preventDefault();
      onDraftChange(promptSuggestion);
      return;
    }

    if (event.key !== "Enter" || event.shiftKey) return;
    const commandEnter = commandModified;
    const shouldSend = sendOnEnter ? !commandEnter : commandEnter;
    if (!shouldSend) return;
    event.preventDefault();
    submitComposerDraft();
  };

  const openUploadPicker = () => {
    if (!canAttach) return;
    uploadInputRef.current?.click();
  };

  const handlePaste = (event: React.ClipboardEvent<HTMLElement>) => {
    if (!canAttach) return;
    // If the keydown fallback already attached the clipboard image (timeout
    // fired before this paste event landed), bail out so we don't double-attach.
    const fallbackAlreadyAttached = clipboardImagePasteFallbackAttachedRef.current;
    clipboardImagePasteFallbackAttachedRef.current = false;
    const collected: File[] = [];
    let hasImageItem = false;
    if (event.clipboardData.files.length) {
      for (const file of Array.from(event.clipboardData.files)) collected.push(file);
    }
    if (!collected.length && event.clipboardData.items?.length) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.type.startsWith("image/")) hasImageItem = true;
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) collected.push(file);
      }
    }
    if (!collected.length) {
      if (hasImageItem) {
        event.preventDefault();
        if (fallbackAlreadyAttached) return;
        clipboardImagePasteHandledRef.current += 1;
        void addNativeClipboardImageAttachment();
        return;
      }
      if (addImageUrlFromTransfer(event.clipboardData, { showNotice: true })) {
        event.preventDefault();
      }
      return;
    }
    event.preventDefault();
    if (fallbackAlreadyAttached) return;
    clipboardImagePasteHandledRef.current += 1;
    void addFileAttachments(collected);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    const hasImageUrl = event.dataTransfer.types.includes("text/uri-list");
    if (!canAttach || (!event.dataTransfer.files.length && !hasImageUrl)) return;
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    setDragActive(false);
    const hasFiles = event.dataTransfer.files.length > 0;
    const hasUriList = event.dataTransfer.types.includes("text/uri-list");
    if (!canAttach || (!hasFiles && !hasUriList)) return;
    event.preventDefault();
    if (!hasFiles && !addImageUrlFromTransfer(event.dataTransfer)) return;
    if (hasFiles) {
      void addFileAttachments(event.dataTransfer.files);
    }
  };

  const handleCommandMenuSelect = useCallback((item: ChatCommandMenuItem) => {
    if (composerInputLocked) {
      setCommandMenuTrigger(null);
      return;
    }
    if (item.type === "file" && commandMenuTrigger) {
      if (!canAttach) {
        setAttachError(attachBlockedReason ?? "Attachments are unavailable right now.");
        setCommandMenuTrigger(null);
        return;
      }
      // Replace exactly the @query trigger span with the confirmed token.
      if (useRichComposer) {
        if (!replaceRichTriggerWith({ chipKind: "file", chipText: `@${item.path}` })) {
          insertTextIntoRichEditor(`@${item.path} `);
        }
      } else {
        const next = replaceComposerTriggerSpan(draft, commandMenuTrigger, `@${item.path} `);
        onDraftChange(next.text);
        restoreTextareaCaret(next.caret);
      }
      onAddAttachment({ path: item.path, type: inferAttachmentType(item.path) });
    } else if (item.type === "command" && commandMenuTrigger) {
      const selected = effectiveSlashCommands.find((cmd) => cmd.command.replace(/^\//, "") === item.name);
      const wholeDraft = composerTriggerSpansWholeDraft(draft, commandMenuTrigger);
      // A lone command keeps the legacy path (local /clear intercept +
      // argument-hint scaffold). Rich mode only takes it for the local /clear
      // intercept — handleSlashSelect rewrites the whole editor, which would
      // wipe context chips.
      const useLegacySlashSelect = Boolean(selected) && wholeDraft
        && (!useRichComposer || (selected?.command === "/clear" && selected.source === "local"));
      if (selected && useLegacySlashSelect) {
        handleSlashSelect(selected);
      } else if (useRichComposer) {
        if (!replaceRichTriggerWith({ chipKind: "command", chipText: `/${item.name}` })) {
          insertTextIntoRichEditor(`/${item.name} `);
        }
      } else {
        const next = replaceComposerTriggerSpan(draft, commandMenuTrigger, `/${item.name} `);
        onDraftChange(next.text);
        restoreTextareaCaret(next.caret);
      }
    }
    setCommandMenuTrigger(null);
  }, [attachBlockedReason, canAttach, commandMenuTrigger, composerInputLocked, draft, effectiveSlashCommands, handleSlashSelect, insertTextIntoRichEditor, onDraftChange, onAddAttachment, replaceRichTriggerWith, restoreTextareaCaret, useRichComposer]);

  const handleRichEditorInput = useCallback(() => {
    const editor = richEditorRef.current;
    if (!editor) return;
    const val = serializeRichEditor();
    onDraftChange(val);
    if (imeComposingRef.current) {
      captureRichSelection();
      return;
    }
    const context = getRichTriggerContext();
    if (context) {
      setCommandMenuTrigger(context.trigger);
      const anchor = getCommandMenuAnchor(editor);
      if (anchor) setCommandMenuAnchor(anchor);
    } else {
      setCommandMenuTrigger(null);
    }
    captureRichSelection();
  }, [captureRichSelection, getRichTriggerContext, onDraftChange, serializeRichEditor]);

  const singleModelBlockedMessage = modelUnavailableMessage?.trim() ? modelUnavailableMessage : null;
  const singleModelReady = Boolean(modelId) && !singleModelBlockedMessage;

  const submitComposerDraft = useCallback(() => {
    if (pendingInput?.blocking) {
      return;
    }
    if (pendingImageAttachments.length > 0) {
      return;
    }
    if (parallelChatMode) {
      if (busy || parallelLaunchBusy) return;
      if (parallelModelSlots.length < 2) return;
      const hasPrompt = draft.trim().length > 0;
      const hasAttachments = attachments.length > 0 || contextAttachmentCount > 0;
      if (!hasPrompt && !hasAttachments) return;
      onSubmit();
      return;
    }
    // Cloud submit only fires when the chat is fresh enough to launch a new cloud run. Once any
    // turns have been exchanged the inline launch strip is unavailable, so this branch is gated
    // on `cursorCloudCanLaunch` to defend against a stale `cursorCloudLaunchModeOpen=true`.
    const hasContextSelection =
      iosElementContextItems.length > 0
      || appControlContextItems.length > 0
      || builtInBrowserContextItems.length > 0;
    if (
      cursorCloudAvailable
      && cursorCloudCanLaunch
      && cursorCloudLaunchModeOpen
      && onSubmitToCloud
    ) {
      const trimmed = draft.trim();
      if (!trimmed.length && !hasContextSelection && contextAttachmentCount === 0) return;
      const issueContextPrompt = buildChatContextAttachmentPrompt(contextAttachments);
      const cloudPrompt = [
        issueContextPrompt || null,
        trimmed || (issueContextPrompt ? "Use the attached issue context." : null),
      ].filter((part): part is string => Boolean(part)).join("\n\n");
      void Promise.resolve(onSubmitToCloud(cloudPrompt)).then((ok) => {
        if (ok) onDraftChange("");
      });
      return;
    }
    if (busy || !singleModelReady || (!draft.trim().length && !hasContextSelection && contextAttachmentCount === 0)) {
      if (!busy && !singleModelReady) onSubmitBlocked?.(singleModelBlockedMessage ?? "Select a model first");
      return;
    }
    onSubmit();
  }, [appControlContextItems.length, attachments, builtInBrowserContextItems.length, busy, contextAttachmentCount, contextAttachments, cursorCloudAvailable, cursorCloudCanLaunch, cursorCloudLaunchModeOpen, draft, iosElementContextItems.length, onDraftChange, onSubmit, onSubmitBlocked, onSubmitToCloud, pendingImageAttachments.length, pendingInput, parallelChatMode, parallelLaunchBusy, parallelModelSlots.length, singleModelBlockedMessage, singleModelReady]);

  const showPendingInputOptionsHint = hasPendingInputOptions(pendingInput);
  const selectedIosContext = iosElementContextItems.find((item) => item.id === selectedIosContextId) ?? null;
  const selectedAppControlContext = appControlContextItems.find((item) => item.id === selectedAppControlContextId) ?? null;
  const selectedBuiltInBrowserContext = builtInBrowserContextItems.find((item) => item.id === selectedBuiltInBrowserContextId) ?? null;
  const selectedIosCandidates = selectedIosContext
    ? iosMetadataArray(selectedIosContext.metadata.sourceCandidates ?? selectedIosContext.metadata.sourceMatches).slice(0, 3)
    : [];
  const selectedNearbyIosElements = selectedIosContext
    ? iosMetadataArray(selectedIosContext.metadata.nearbyElements).slice(0, 6)
    : [];
  const selectedAppControlCandidates = selectedAppControlContext
    ? iosMetadataArray(selectedAppControlContext.metadata.sourceCandidates).slice(0, 3)
    : [];
  const selectedAppControlNearby = selectedAppControlContext
    ? iosMetadataArray(selectedAppControlContext.metadata.nearbyElements).slice(0, 6)
    : [];
  const selectedAppControlSnippet = typeof selectedAppControlContext?.metadata.sourceSnippet === "string"
    ? selectedAppControlContext.metadata.sourceSnippet
    : null;
  useEffect(() => {
    if (!selectedIosContextId) return;
    if (iosElementContextItems.some((item) => item.id === selectedIosContextId)) return;
    setSelectedIosContextId(null);
  }, [iosElementContextItems, selectedIosContextId]);
  useEffect(() => {
    if (!selectedAppControlContextId) return;
    if (appControlContextItems.some((item) => item.id === selectedAppControlContextId)) return;
    setSelectedAppControlContextId(null);
  }, [appControlContextItems, selectedAppControlContextId]);
  useEffect(() => {
    if (!selectedBuiltInBrowserContextId) return;
    if (builtInBrowserContextItems.some((item) => item.id === selectedBuiltInBrowserContextId)) return;
    setSelectedBuiltInBrowserContextId(null);
  }, [builtInBrowserContextItems, selectedBuiltInBrowserContextId]);
  // Idle composer motion keeps the GPU busy; keep the animated beam to active
  // turns and explicit orchestration mode.
  // BorderBeam disabled — the traveling beam around the composer read as
  // distracting chrome. (Orchestrator mode keeps its own separate glow.)
  const composerBeamActive = false
    && isActive
    && layoutVariant !== "grid-tile"
    && !iosSimulatorOpen
    && (turnActive || orchestratorModeActive);
  const composerBeamVariant = orchestratorModeActive ? "colorful" : turnActive ? "ocean" : "colorful";
  const composerBeamDuration = orchestratorModeActive ? 8 : turnActive ? 20 : 5;
  const composerBeamStrength = orchestratorModeActive ? 0.68 : turnActive ? 0.26 : 0.44;

  const parallelReady =
    parallelChatMode
    && parallelModelSlots.length >= 2
    && (draft.trim().length > 0 || attachments.length > 0 || contextAttachmentCount > 0);
  const hasIosElementContext = iosElementContextItems.length > 0;
  const hasAppControlContext = appControlContextItems.length > 0;
  const hasBuiltInBrowserContext = builtInBrowserContextItems.length > 0;
  const singleReady = !parallelChatMode && singleModelReady && (
    draft.trim().length > 0
    || (allowAttachmentOnlySubmit && attachments.length > 0)
    || hasIosElementContext
    || hasAppControlContext
    || hasBuiltInBrowserContext
    || contextAttachmentCount > 0
  );
  const hasPendingImageAttachments = pendingImageAttachments.length > 0;
  const sendEnabled = !busy && !backgroundLaunchBusy && !parallelLaunchBusy && !composerInputLocked && !hasPendingImageAttachments && (parallelReady || singleReady);
  const backgroundSendEnabled = Boolean(onSubmitInBackground)
    && !busy
    && !backgroundLaunchBusy
    && !parallelLaunchBusy
    && !composerInputLocked
    && !hasPendingImageAttachments
    && singleReady;
  const normalizedBackgroundLaunchLabel = backgroundLaunchLabel.trim() || "Background";
  const backgroundLaunchActionLabel = normalizedBackgroundLaunchLabel === "Background"
    ? "Launch in background"
    : `${normalizedBackgroundLaunchLabel} in background`;

  function sendButtonTitle(): string {
    if (composerInputLocked) return composerInputLockMessage ?? "Resolve the pending request before sending.";
    if (hasPendingImageAttachments) return "Finish attaching images";
    if (parallelChatMode) {
      if (parallelModelSlots.length < 2) return "Add at least two models";
      if (draft.trim().length === 0 && attachments.length === 0 && contextAttachmentCount === 0) return "Add a message or at least one attachment";
      return "Send to all lanes";
    }
    if (!modelId) return singleModelBlockedMessage ?? "Select a model first";
    if (singleModelBlockedMessage) return singleModelBlockedMessage;
    if (!draft.trim().length && allowAttachmentOnlySubmit && attachments.length > 0) return "Send attached files";
    if (!draft.trim().length && contextAttachmentCount > 0) return "Send attached issue context";
    if (!draft.trim().length && hasAppControlContext) return "Send selected App Control context";
    if (!draft.trim().length && hasIosElementContext) return "Send selected iOS context";
    if (!draft.trim().length && hasBuiltInBrowserContext) return "Send selected browser context";
    return "Send";
  }

  const composerFrameClassName = cn(
    "m-3 mt-0 rounded-[var(--chat-radius-shell)]",
    layoutVariant === "grid-tile" ? "m-0" : "",
  );
  const issueContextMenu = issueContextMenuOpen && issueContextButtonRef.current ? createPortal(
    <div
      className="ade-chat-drawer-glass fixed z-[1000] overflow-hidden"
      data-issue-context-menu="true"
      role="menu"
      aria-label="Attach issue context"
      style={getIssueContextMenuStyle(issueContextButtonRef.current)}
    >
      <div className="border-b border-white/[0.04] px-3 py-2">
        <div className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-semibold text-fg/80">Attach issue context</div>
      </div>
      <div className="p-1">
        <button
          type="button"
          className="ade-chat-drawer-row flex w-full items-center gap-2 rounded-lg px-3 py-2.5 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/75"
          disabled={!canAttachIssueContext}
          onClick={() => {
            if (!canAttachIssueContext) return;
            setIssueContextMenuOpen(false);
            setLinearIssuePickerOpen(true);
          }}
        >
          <span
            className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
            style={{ background: LINEAR_BRAND.surfaceHover, color: LINEAR_BRAND.primaryBright }}
          >
            <LinearMark size={11} />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">Linear issue</span>
            <span className="block truncate text-[length:calc(var(--chat-font-size)*9/14)] text-muted-fg/45">Attach a ticket as chat context.</span>
          </span>
        </button>
        <button
          type="button"
          className="flex w-full cursor-not-allowed items-center gap-2 rounded-lg px-3 py-2.5 text-left font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-muted-fg/30"
          disabled
        >
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-white/[0.04] text-muted-fg/35">
            <GithubLogo size={13} weight="fill" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block font-medium">GitHub issue</span>
            <span className="block truncate text-[length:calc(var(--chat-font-size)*9/14)] text-muted-fg/30">Coming later.</span>
          </span>
        </button>
      </div>
    </div>,
    document.body,
  ) : null;

  const selectedLinearContextIssue = contextAttachments.find(
    (attachment): attachment is Extract<AgentChatContextAttachment, { type: "linear_issue" }> => (
      attachment.type === "linear_issue"
    ),
  )?.issue ?? null;
  const isMcpElicitation = pendingInput?.providerMetadata?.mcpElicitation === true;
  const mcpElicitationSupportsPersistence = pendingInput?.providerMetadata?.persistenceSupported === true;
  const mcpElicitationUrl = typeof pendingInput?.providerMetadata?.url === "string"
    && canOpenInAdeBrowser(pendingInput.providerMetadata.url)
    ? pendingInput.providerMetadata.url
    : null;

  return (
    <>
      {issueContextMenu}
      <LinearIssueSelectModal
        open={linearIssuePickerOpen}
        ariaLabel="Attach Linear issue"
        selectedIssue={selectedLinearContextIssue}
        pinnedIssue={pinnedLinearIssue}
        pinnedIssueLabel={pinnedLinearIssue ? "Linked to this lane" : "Attached to chat"}
        actionLabel="Attach issue"
        actionBusyLabel="Attaching issue"
        actionDisabled={busy || parallelLaunchBusy}
        showBranchPreview={false}
        onOpenChange={setLinearIssuePickerOpen}
        onSelectIssue={(laneIssue) => {
          onAddContextAttachment?.(makeLinearIssueContextAttachment(
            laneIssue,
            pinnedLinearIssue?.id === laneIssue.id ? "lane_link" : "manual",
          ));
        }}
        onOpenLinearSettings={onOpenLinearSettings}
      />
      {showLaunchClipboardNotice && layoutVariant !== "grid-tile" ? (
        <div className="mx-auto mb-1.5 w-full max-w-[var(--chat-column,52rem)] px-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/45">
          Prompt copies to clipboard on send.{" "}
          <button
            type="button"
            className="text-fg/70 underline decoration-white/20 underline-offset-2 transition-colors hover:text-fg"
            onClick={onOpenLaunchPromptClipboardSettings}
          >
            Setting
          </button>
        </div>
      ) : null}
      {voiceError ? (
        <div
          role="status"
          className="mx-auto mb-1.5 flex w-full max-w-[var(--chat-column,52rem)] items-center justify-between gap-2 px-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-amber-300/80"
        >
          <span>{voiceError}</span>
          <button
            type="button"
            className="text-amber-200/60 underline decoration-amber-200/20 underline-offset-2 transition-colors hover:text-amber-100"
            onClick={() => setVoiceError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <BorderBeam
        size="md"
        colorVariant={composerBeamVariant}
        duration={composerBeamDuration}
        strength={composerBeamStrength}
        active={composerBeamActive}
        borderRadius={18}
        className={composerFrameClassName}
        style={{ overflow: "visible" }}
      >
      <ChatComposerShell
      mode={surfaceMode}
      glowColor={composerGlowColor}
      orchestratorActive={orchestratorModeActive}
      className={cn(
        layoutVariant === "grid-tile"
          ? "border-0 bg-transparent shadow-none"
          : "mx-auto w-full max-w-[var(--chat-column,52rem)]",
      )}
      pendingBanner={pendingInput ? (
        pendingInput.kind === "plan_approval" ? (
          <ChatProposedPlanCard
            source={pendingInput.source}
            description={pendingInput.description ?? null}
            question={pendingInput.questions[0]?.question ?? null}
            disabled={approvalResponding ?? false}
            onApprove={() => onApproval("accept")}
            onReject={() => onApproval("decline")}
          />
        ) : pendingInput.kind === "model_selection" ? (
          (() => {
            // Decode the orchestration model-selection metadata payload. The
            // server packs `{ role, tag, suggested?, availableModels? }` into
            // `providerMetadata`; if it's malformed we fall back to a
            // permissive shape so the user can still pick a model.
            const meta = readOrchestrationModelSelectionMetadata(pendingInput.providerMetadata);
            const availableModelIdsForPicker = meta?.availableModels && Array.isArray(meta.availableModels)
              ? (meta.availableModels as unknown[]).filter((id): id is string => typeof id === "string")
              : availableModelIds;
            return (
              <ChatModelSelectionPendingCard
                metadata={meta}
                {...(availableModelIdsForPicker ? { availableModelIds: availableModelIdsForPicker } : {})}
                {...(providerAuthStatus ? { providerAuthStatus } : {})}
                responding={approvalResponding ?? false}
                onConfirm={(selection) => {
                  onApproval("accept", null, { selection: JSON.stringify(selection) });
                }}
                onCancel={() => onApproval("cancel")}
              />
            );
          })()
        ) : (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-black/20">
                <ProviderLogo family={pendingInput.source} size={12} />
              </span>
              <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-widest text-[color:color-mix(in_srgb,var(--chat-accent)_82%,white_18%)]">
                {pendingInputHeaderLabel(pendingInput.source, pendingInput.kind)}
              </span>
            </div>
            {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? (
              <>
                <div className="mb-2 font-mono text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-fg/68">
                  {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent is waiting for input."}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  {isMcpElicitation && mcpElicitationUrl ? (
                    <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-sky-300/25 bg-sky-400/[0.08] px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-sky-100/80 transition-colors hover:bg-sky-400/[0.14] disabled:pointer-events-none disabled:opacity-40" onClick={() => openUrlInAdeBrowser(mcpElicitationUrl)}>Open authorization</button>
                  ) : null}
                  <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-accent/30 bg-accent/12 px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept")}>{approvalResponding ? "Processing..." : isMcpElicitation ? "Allow once" : "Accept"}</button>
                  {!isMcpElicitation || mcpElicitationSupportsPersistence ? (
                    <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept_for_session")}>{isMcpElicitation ? "Always allow" : "Accept all"}</button>
                  ) : null}
                  <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("decline")}>{isMcpElicitation ? "Deny" : "Decline"}</button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.14em] text-[color:color-mix(in_srgb,var(--chat-accent)_66%,white_34%)]">
                  {showPendingInputOptionsHint
                    ? "Answer in the inline question card, or pick an option there."
                    : "Answer in the inline question card, or decline."}
                </span>
                <button
                  type="button"
                  disabled={approvalResponding}
                  className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none"
                  onClick={() => onApproval("decline")}
                >
                  Decline
                </button>
              </div>
            )}
          </div>
        )
      ) : undefined}
      trays={
        attachments.length || pendingImageAttachments.length || contextAttachmentCount || attachError || attachNotice || selectedIosContext || selectedAppControlContext || selectedBuiltInBrowserContext ? (
          <div className="space-y-2 px-1 py-2">
            {selectedBuiltInBrowserContext ? (
              <div className="relative mx-3 grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-md border border-teal-300/12 bg-black/20 p-2 pr-6">
                <button
                  type="button"
                  aria-label="Dismiss preview"
                  className="absolute right-1.5 top-1.5 rounded p-0.5 text-teal-100/40 transition-colors hover:text-teal-50/85"
                  onClick={() => setSelectedBuiltInBrowserContextId(null)}
                >
                  <X size={10} weight="bold" />
                </button>
                {selectedBuiltInBrowserContext.screenshotDataUrl ? (
                  <img
                    src={selectedBuiltInBrowserContext.screenshotDataUrl}
                    alt=""
                    className="h-16 w-16 rounded border border-white/[0.06] object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded border border-white/[0.06] bg-white/[0.03] text-teal-100/35">
                    <Globe size={20} weight="regular" />
                  </div>
                )}
                <div className="min-w-0 space-y-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/70">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 rounded border border-teal-300/22 bg-teal-500/8 px-1 py-px font-mono text-[length:calc(var(--chat-font-size)*8/14)] uppercase text-teal-100/75">
                      Browser
                    </span>
                    <span className="truncate text-teal-50/85">{builtInBrowserContextDisplayLabel(selectedBuiltInBrowserContext)}</span>
                    {builtInBrowserContextRoleHint(selectedBuiltInBrowserContext) ? (
                      <span className="shrink-0 rounded bg-white/[0.04] px-1 py-px font-mono text-[length:calc(var(--chat-font-size)*8/14)] uppercase text-muted-fg/55">
                        {builtInBrowserContextRoleHint(selectedBuiltInBrowserContext)}
                      </span>
                    ) : null}
                  </div>
                  <div className="truncate">{builtInBrowserContextSourceDescription(selectedBuiltInBrowserContext)}</div>
                  {selectedBuiltInBrowserContext.url ? (
                    <div className="truncate text-teal-100/45">{selectedBuiltInBrowserContext.url}</div>
                  ) : null}
                  {typeof selectedBuiltInBrowserContext.metadata.selector === "string" ? (
                    <div className="truncate font-mono text-[length:calc(var(--chat-font-size)*9/14)] text-teal-50/55">
                      {selectedBuiltInBrowserContext.metadata.selector}
                    </div>
                  ) : null}
                  {builtInBrowserContextFrameHint(selectedBuiltInBrowserContext) ? (
                    <div className="text-muted-fg/45">{builtInBrowserContextFrameHint(selectedBuiltInBrowserContext)}</div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {selectedAppControlContext ? (
              <div className="relative mx-3 grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-md border border-sky-300/12 bg-black/20 p-2 pr-6">
                <button
                  type="button"
                  aria-label="Dismiss preview"
                  className="absolute right-1.5 top-1.5 rounded p-0.5 text-sky-100/40 transition-colors hover:text-sky-50/85"
                  onClick={() => setSelectedAppControlContextId(null)}
                >
                  <X size={10} weight="bold" />
                </button>
                {selectedAppControlContext.screenshotDataUrl ? (
                  <img
                    src={selectedAppControlContext.screenshotDataUrl}
                    alt=""
                    className="h-16 w-16 rounded border border-white/[0.06] object-cover"
                  />
                ) : (
                  <div className="flex h-16 w-16 items-center justify-center rounded border border-white/[0.06] bg-white/[0.03] text-sky-100/35">
                    <Desktop size={20} weight="regular" />
                  </div>
                )}
                <div className="min-w-0 space-y-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/70">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="shrink-0 rounded border border-sky-300/22 bg-sky-500/8 px-1 py-px font-mono text-[length:calc(var(--chat-font-size)*8/14)] uppercase tracking-wide text-sky-100/75">
                      App Control
                    </span>
                    <span className="truncate text-sky-50/85">{appControlContextDisplayLabel(selectedAppControlContext)}</span>
                    {appControlContextRoleHint(selectedAppControlContext) ? (
                      <span className="shrink-0 rounded bg-white/[0.04] px-1 py-px font-mono text-[length:calc(var(--chat-font-size)*8/14)] uppercase tracking-wide text-muted-fg/55">
                        {appControlContextRoleHint(selectedAppControlContext)}
                      </span>
                    ) : null}
                  </div>
                  {selectedAppControlContext.sourceFile ? (
                    <div className="truncate text-sky-100/65">
                      {selectedAppControlContext.sourceFile}
                      {selectedAppControlContext.sourceLine ? `:${selectedAppControlContext.sourceLine}` : ""}
                    </div>
                  ) : (
                    <div className="truncate">{appControlContextSourceDescription(selectedAppControlContext)}</div>
                  )}
                  {typeof selectedAppControlContext.metadata.url === "string" ? (
                    <div className="truncate text-sky-100/45">{selectedAppControlContext.metadata.url}</div>
                  ) : null}
                  {appControlContextFrameHint(selectedAppControlContext) ? (
                    <div className="text-muted-fg/45">{appControlContextFrameHint(selectedAppControlContext)}</div>
                  ) : null}
                  {selectedAppControlSnippet && selectedAppControlSnippet.trim().length ? (
                    <pre className="mt-1 max-h-24 overflow-auto rounded border border-white/[0.05] bg-black/20 p-1.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] leading-4 text-sky-50/70">
                      {selectedAppControlSnippet}
                    </pre>
                  ) : selectedAppControlCandidates.length ? (
                    <div className="space-y-1">
                      <div className="text-sky-100/45">Best source candidates</div>
                      {selectedAppControlCandidates.map((candidate, index) => (
                        <div key={`${candidate.sourceFile}:${candidate.sourceLine}:${index}`} className="rounded border border-white/[0.05] bg-white/[0.025] px-1.5 py-1">
                          <div className="truncate text-sky-50/70">
                            {String(candidate.sourceFile ?? "unknown")}{candidate.sourceLine ? `:${String(candidate.sourceLine)}` : ""}
                          </div>
                          {candidate.reason ? <div className="truncate text-muted-fg/50">{String(candidate.reason)}</div> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-amber-100/55">No source match for this element. Add a data-testid or an aria-label that matches a string in source.</div>
                  )}
                  {selectedAppControlNearby.length ? (
                    <div className="space-y-1">
                      <div className="text-sky-100/45">Nearby screen context</div>
                      <div className="flex flex-wrap gap-1">
                        {selectedAppControlNearby.map((element, index) => (
                          <span key={`${String(element.id ?? index)}:${index}`} className="max-w-[160px] truncate rounded border border-white/[0.05] bg-white/[0.025] px-1.5 py-0.5 text-muted-fg/55">
                            {String(element.label ?? element.role ?? element.tagName ?? "element")}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {selectedIosContext ? (
              <div className="relative mx-3 grid grid-cols-[72px_minmax(0,1fr)] gap-2 rounded-md border border-cyan-300/12 bg-black/20 p-2">
                <button
                  type="button"
                  aria-label="Dismiss preview"
                  className="absolute right-1.5 top-1.5 rounded p-0.5 text-cyan-100/40 transition-colors hover:text-cyan-50/85"
                  onClick={() => setSelectedIosContextId(null)}
                >
                  <X size={10} weight="bold" />
                </button>
                {selectedIosContext.screenshotDataUrl ? (
                  <img
                    src={selectedIosContext.screenshotDataUrl}
                    alt=""
                    className="h-16 w-16 rounded border border-white/[0.06] object-cover"
                  />
                ) : (
                  <div className="h-16 w-16 rounded border border-white/[0.06] bg-white/[0.03]" />
                )}
                <div className="min-w-0 space-y-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/70">
                  <div className="truncate text-cyan-50/85">{iosContextDisplayLabel(selectedIosContext)}</div>
                  {selectedIosContext.sourceFile ? (
                    <div className="truncate">{selectedIosContext.sourceFile}{selectedIosContext.sourceLine ? `:${selectedIosContext.sourceLine}` : ""}</div>
                  ) : (
                    <div>{iosContextSourceDescription(selectedIosContext)}</div>
                  )}
                  {typeof selectedIosContext.metadata.sourceResolution === "string" ? (
                    <div className="text-cyan-100/45">
                      {iosSourceResolutionLabel(selectedIosContext.metadata.sourceResolution)}
                    </div>
                  ) : null}
                  {iosFrameLabel(selectedIosContext) ? <div>{iosFrameLabel(selectedIosContext)}</div> : null}
                  {typeof selectedIosContext.metadata.sourceSnippet === "string" && selectedIosContext.metadata.sourceSnippet.trim().length ? (
                    <pre className="mt-1 max-h-24 overflow-auto rounded border border-white/[0.05] bg-black/20 p-1.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] leading-4 text-cyan-50/70">
                      {selectedIosContext.metadata.sourceSnippet}
                    </pre>
                  ) : selectedIosCandidates.length ? (
                    <div className="space-y-1">
                      <div className="text-cyan-100/45">Best source candidates</div>
                      {selectedIosCandidates.map((candidate, index) => (
                        <div key={`${candidate.sourceFile}:${candidate.sourceLine}:${index}`} className="rounded border border-white/[0.05] bg-white/[0.025] px-1.5 py-1">
                          <div className="truncate text-cyan-50/70">
                            {String(candidate.sourceFile ?? "unknown")}{candidate.sourceLine ? `:${String(candidate.sourceLine)}` : ""}
                          </div>
                          {candidate.reason ? <div className="truncate text-muted-fg/50">{String(candidate.reason)}</div> : null}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-amber-100/55">No Swift source match for this accessibility element.</div>
                  )}
                  {selectedNearbyIosElements.length ? (
                    <div className="space-y-1">
                      <div className="text-cyan-100/45">Nearby screen context</div>
                      <div className="flex flex-wrap gap-1">
                        {selectedNearbyIosElements.map((element, index) => (
                          <span key={`${String(element.id ?? index)}:${index}`} className="max-w-[160px] truncate rounded border border-white/[0.05] bg-white/[0.025] px-1.5 py-0.5 text-muted-fg/55">
                            {String(element.label ?? element.componentId ?? element.role ?? element.elementType ?? "element")}
                          </span>
                        ))}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
            {attachError ? (
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-[length:calc(var(--chat-font-size)*10/14)] text-red-300/75">{attachError}</span>
                <button
                  type="button"
                  aria-label="Dismiss error"
                  className="shrink-0 rounded p-0.5 text-red-300/60 hover:text-red-200/80 transition-colors"
                  onClick={() => setAttachError(null)}
                >
                  <X size={10} weight="bold" />
                </button>
              </div>
            ) : null}
            {attachNotice ? (
              <div className="flex items-center gap-2 px-3" role="status">
                <span className="text-[length:calc(var(--chat-font-size)*10/14)] text-sky-200/85">
                  {attachNotice.message}
                </span>
                <button
                  type="button"
                  className="rounded px-1.5 py-0.5 text-[length:calc(var(--chat-font-size)*10/14)] text-sky-200/65 underline-offset-2 transition-colors hover:text-sky-100 hover:underline"
                  onClick={() => {
                    handleRemoveAttachment(attachNotice.undoPath);
                    setAttachNotice(null);
                  }}
                >
                  undo
                </button>
                <button
                  type="button"
                  aria-label="Dismiss"
                  className="ml-auto shrink-0 rounded p-0.5 text-sky-200/55 hover:text-sky-100 transition-colors"
                  onClick={() => setAttachNotice(null)}
                >
                  <X size={10} weight="bold" />
                </button>
              </div>
            ) : null}
            <ChatAttachmentTray
              ref={attachmentTrayRef}
              attachments={attachments}
              contextAttachments={contextAttachments}
              pendingImageAttachments={pendingImageAttachments}
              imagePreviewUrls={imagePreviewUrls}
              mode={surfaceMode}
              onRemove={handleRemoveAttachment}
              onRemoveContext={onRemoveContextAttachment}
              onRemovePendingImageAttachment={removePendingImageAttachment}
              onFocusPrompt={focusComposerInput}
              className="px-3 py-0"
            />
          </div>
        ) : undefined
      }
      pickerLayer={
        <>
          <input
            ref={uploadInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              void addFileAttachments(event.target.files);
              event.currentTarget.value = "";
            }}
          />
          {attachmentPickerOpen ? (
            <div className="ade-chat-drawer-glass absolute bottom-full left-3 z-10 mb-3 w-80 overflow-hidden">
              <div className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-2.5">
                <At size={11} weight="bold" className="text-muted-fg/30" />
                <input
                  ref={attachmentInputRef}
                  value={attachmentQuery}
                  onChange={(e) => setAttachmentQuery(e.target.value)}
                  placeholder="Search files..."
                  className="h-5 flex-1 bg-transparent font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/80 outline-none placeholder:text-muted-fg/25"
                  onKeyDown={(event) => {
                    if (event.key === "Escape") { event.preventDefault(); setAttachmentPickerOpen(false); return; }
                    if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setAttachmentCursor((v) => Math.min(v + 1, Math.max(attachmentResults.length - 1, 0)));
                      return;
                    }
                    if (event.key === "ArrowUp") { event.preventDefault(); setAttachmentCursor((v) => Math.max(v - 1, 0)); return; }
                    if (event.key === "Enter") {
                      const candidate = attachmentResults[attachmentCursor];
                      if (candidate) { event.preventDefault(); selectAttachment(candidate); }
                    }
                  }}
                />
              </div>
              <div className="max-h-40 overflow-auto py-1">
                {!attachmentQuery.trim().length ? (
                  <div className="px-3 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/25">Type to search files...</div>
                ) : attachmentBusy ? (
                  <div className="px-3 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/25">Searching...</div>
                ) : attachmentResults.length ? (
                  attachmentResults.map((result, index) => (
                    <button
                      key={result.path}
                      type="button"
                      data-active={index === attachmentCursor}
                      className={cn(
                        "ade-chat-drawer-row mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-2.5 text-left font-mono text-[length:calc(var(--chat-font-size)*10/14)]",
                        index === attachmentCursor ? "text-fg/85" : "text-fg/60",
                      )}
                      onMouseEnter={() => setAttachmentCursor(index)}
                      onClick={() => selectAttachment(result)}
                    >
                      {result.type === "image" ? <Image size={11} weight="bold" className="text-muted-fg/40" /> : <At size={11} weight="bold" className="text-muted-fg/25" />}
                      <span className="truncate">{result.path}</span>
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-2 font-mono text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/25">No matching files.</div>
                )}
              </div>
            </div>
          ) : null}
        </>
      }
      footer={
        <div className="ade-chat-composer-footer flex flex-col gap-2 px-2 py-1 sm:px-2.5">
          {parallelChatMode ? (
            <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_06%,transparent)] p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-semibold text-fg/88">Parallel launch</div>
                  <p className="mt-1 font-sans text-[length:calc(var(--chat-font-size)*11/14)] leading-relaxed text-muted-fg/55">
                    Configure each model, then send once. Attachments go to every lane (max {PARALLEL_CHAT_MAX_ATTACHMENTS}).
                  </p>
                </div>
                <SmartTooltip content={{ label: "Single model", description: "Turn off parallel launch and return this draft to one chat session." }}>
                  <button
                    type="button"
                    disabled={parallelLaunchBusy}
                    className="shrink-0 rounded-lg border border-white/[0.1] px-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium text-muted-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg/80 disabled:opacity-40"
                    onClick={() => {
                      onParallelChatModeChange?.(false);
                      onParallelConfiguringIndexChange?.(null);
                    }}
                  >
                    Single model
                  </button>
                </SmartTooltip>
              </div>
              <div className="mt-3 flex flex-col gap-2">
                {parallelModelSlots.map((slotRow, idx) => {
                  const desc = getModelById(slotRow.modelId);
                  const configuring = parallelConfiguringIndex === idx;
                  return (
                    <div
                      key={`parallel-slot-${idx}`}
                      className={cn(
                        "flex flex-wrap items-center gap-2 rounded-lg border px-2.5 py-2 transition-colors",
                        configuring
                          ? "border-[color:color-mix(in_srgb,var(--chat-accent)_35%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] shadow-[0_0_0_1px_color-mix(in_srgb,var(--chat-accent)_12%,transparent)]"
                          : "border-white/[0.07] bg-white/[0.02]",
                      )}
                    >
                      <span className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-md bg-white/[0.06] font-mono text-[length:calc(var(--chat-font-size)*10/14)] font-bold text-muted-fg/50">
                        {idx + 1}
                      </span>
                      <span className="min-w-0 max-w-[min(200px,46%)] truncate font-sans text-[length:calc(var(--chat-font-size)*12/14)] font-medium text-fg/82">
                        {(desc?.displayName ?? slotRow.modelId) || "Pick a model"}
                      </span>
                      <SmartTooltip content={{ label: configuring ? "Stop configuring" : "Configure model", description: "Edit the model, reasoning, permissions, and launch mode for this parallel lane." }}>
                        <button
                          type="button"
                          className={cn(
                            "rounded-md px-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] font-medium transition-colors",
                            configuring
                              ? "bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)] text-fg/90"
                              : "text-muted-fg/55 hover:bg-white/[0.06] hover:text-fg/75",
                          )}
                          disabled={parallelLaunchBusy}
                          onClick={() => onParallelConfiguringIndexChange?.(configuring ? null : idx)}
                        >
                          {configuring ? "Editing" : "Configure"}
                        </button>
                      </SmartTooltip>
                      {parallelModelSlots.length > 2 ? (
                        <span className="ml-auto inline-flex">
                          <SmartTooltip content={{ label: "Remove model", description: "Remove this model from the parallel launch set." }}>
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-red-400/75 transition-colors hover:bg-red-500/10"
                              disabled={parallelLaunchBusy}
                              onClick={() => onParallelRemoveModel?.(idx)}
                            >
                              <Trash size={12} />
                              Remove
                            </button>
                          </SmartTooltip>
                        </span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <SmartTooltip content={{ label: "Add model", description: "Add another model and child lane to this parallel launch." }}>
                <button
                  type="button"
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/[0.12] px-2.5 py-1.5 font-sans text-[length:calc(var(--chat-font-size)*11/14)] font-medium text-muted-fg/65 transition-colors hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-fg/75 disabled:opacity-40"
                  disabled={parallelLaunchBusy}
                  onClick={() => onParallelAddModel?.()}
                >
                  <Plus size={14} weight="bold" />
                  Add model
                </button>
              </SmartTooltip>
              {parallelLaunchBusy && parallelLaunchStatus ? (
                <div className="mt-3 flex items-center gap-2 rounded-lg border border-white/[0.06] bg-black/20 px-2.5 py-2">
                  <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-[var(--chat-accent)]" />
                  <span className="font-sans text-[length:calc(var(--chat-font-size)*11/14)] text-fg/70">{parallelLaunchStatus}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex min-w-0 items-center gap-1">
          {/* Left: permission + model controls */}
          <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto overflow-y-hidden [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
            {(() => {
              const showNativeControls =
                !parallelChatMode
                || (parallelConfiguringIndex != null && parallelModelSlots[parallelConfiguringIndex]);
              if (!showNativeControls || !nativeControlPanel) return null;
              const wrapForUniformHeight = !parallelChatMode;
              if (!wrapForUniformHeight) return nativeControlPanel;
              return (
                <div
                  className={cn(
                    "min-w-0 flex min-h-6 items-stretch shrink-0",
                    "[&_button]:h-6 [&_button]:max-h-6 [&_button]:min-h-6 [&_button]:shrink-0 [&_button]:py-0",
                    "[&_label]:flex [&_label]:h-6 [&_label]:max-h-6 [&_label]:min-h-6 [&_label]:items-center [&_label]:py-0",
                    "[&_select]:h-6 [&_select]:max-h-6 [&_select]:min-h-6",
                  )}
                >
                  {nativeControlPanel}
                </div>
              );
            })()}
            {parallelChatMode && parallelConfiguringIndex != null && parallelSlotExecutionModeOptions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-px rounded-md border border-white/[0.06] bg-[#1a1a22] p-0.5">
                {parallelSlotExecutionModeOptions.map((option) => {
                  const active = parallelSlotExecutionMode === option.value;
                  return (
                    <SmartTooltip
                      key={option.value}
                      content={{
                        label: option.label,
                        description: option.helper,
                        effect: active ? "Currently selected for this parallel lane." : undefined,
                      }}
                    >
                      <button
                        type="button"
                        className={cn(
                          "rounded-[8px] px-2.5 py-1.5 font-mono text-[length:calc(var(--chat-font-size)*9/14)] font-bold uppercase tracking-wider transition-colors",
                          active ? "bg-white/[0.08] text-fg/80" : "text-muted-fg/35 hover:text-muted-fg/60",
                          parallelLaunchBusy ? "cursor-not-allowed opacity-50" : "",
                        )}
                        disabled={parallelLaunchBusy}
                        onClick={() => onParallelSlotExecutionModeChange?.(option.value)}
                        aria-pressed={active}
                      >
                        {option.label}
                      </button>
                    </SmartTooltip>
                  );
                })}
              </div>
            ) : null}
            {parallelChatMode && parallelConfiguringIndex != null && parallelModelSlots[parallelConfiguringIndex] ? (
              <>
                <ModelPicker
                  value={parallelModelSlots[parallelConfiguringIndex]!.modelId}
                  onChange={(next) => onParallelSlotModelChange?.(parallelConfiguringIndex, next)}
                  surfaceKey={`chat-composer-parallel-${parallelConfiguringIndex}`}
                  {...(availableModelIds ? { availableModelIds } : {})}
                  constrainToAvailableModelIds={constrainModelSelection}
                  {...(providerAuthStatus ? { providerAuthStatus } : {})}
                  {...(onOpenAiSettings ? { onOpenSignIn: onOpenAiSettings } : {})}
                  {...(onRuntimeCatalogRefreshed ? { onRuntimeCatalogRefreshed } : {})}
                  allowCliOnlyModels={allowCliOnlyModels}
                  disabled={parallelLaunchBusy}
                  compact
                  triggerClassName={COMPOSER_MODEL_TRIGGER}
                />
                <ReasoningEffortPicker
                  modelId={parallelModelSlots[parallelConfiguringIndex]!.modelId}
                  reasoningEffort={parallelModelSlots[parallelConfiguringIndex]!.reasoningEffort}
                  onChange={(effort) => onParallelSlotReasoningChange?.(parallelConfiguringIndex, effort)}
                  disabled={parallelLaunchBusy}
                  compact
                  triggerClassName={COMPOSER_TOOLBAR_PICKER_TRIGGER}
                />
                <ComposerFastModeButton
                  active={fastModeActive}
                  disabled={parallelLaunchBusy}
                  supported={fastModeSupported}
                  onToggle={(next) => onParallelSlotFastModeChange?.(parallelConfiguringIndex, next)}
                />
              </>
            ) : null}
            {!parallelChatMode && (orchestrationRole !== "lead" || !sessionId) ? (
              <>
                <ModelPicker
                  value={modelId}
                  onChange={onModelChange}
                  surfaceKey="chat-composer"
                  {...(availableModelIds ? { availableModelIds } : {})}
                  constrainToAvailableModelIds={constrainModelSelection}
                  {...(providerAuthStatus ? { providerAuthStatus } : {})}
                  {...(onOpenAiSettings ? { onOpenSignIn: onOpenAiSettings } : {})}
                  {...(onRuntimeCatalogRefreshed ? { onRuntimeCatalogRefreshed } : {})}
                  allowCliOnlyModels={allowCliOnlyModels}
                  disabled={modelSelectionLocked}
                  compact
                  triggerClassName={COMPOSER_MODEL_TRIGGER}
                />
                <ReasoningEffortPicker
                  modelId={modelId}
                  reasoningEffort={reasoningEffort}
                  onChange={onReasoningEffortChange}
                  disabled={modelSelectionLocked}
                  compact
                  triggerClassName={COMPOSER_TOOLBAR_PICKER_TRIGGER}
                />
                <ComposerFastModeButton
                  active={fastModeActive}
                  disabled={modelSelectionLocked}
                  supported={fastModeSupported}
                  onToggle={onFastModeChange}
                />
              </>
            ) : null}
          </div>

          {!parallelChatMode && usageViewModel ? (
            <ContextUsageDial
              usage={usageViewModel}
              active={turnActive}
              compactionPulse={compactionPulse}
              modelLabel={resolveModelDescriptorWithRuntimeCatalog(modelId)?.displayName ?? undefined}
            />
          ) : null}

          {/* Right: attachment, commands, proof, context, send */}
          <div className="ml-auto flex shrink-0 items-center gap-0.5">
            <SmartTooltip
              forceEnabled
              content={{
                label: "Upload file",
                description: parallelChatMode
                  ? attachBlockedReason ?? "Upload files from disk and send them to every parallel lane."
                  : "Upload a file from disk and attach it to this message.",
              }}
            >
              <button
                type="button"
                className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-fg/35 transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60"
                disabled={!canAttach}
                onClick={openUploadPicker}
                aria-label="Upload file from disk"
              >
                <Paperclip className="h-3 w-3" size={14} weight="bold" />
              </button>
            </SmartTooltip>
            <SmartTooltip
              forceEnabled
              content={{
                label: "Issue context",
                description: canAttachIssueContext
                  ? "Attach a Linear ticket as context for this chat. GitHub issue attachment is coming later."
                  : composerInputLockMessage ?? "Resolve the pending request before adding issue context.",
              }}
            >
              <button
                type="button"
                ref={issueContextButtonRef}
                className={cn(
                  "relative inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-muted-fg/35 transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60",
                  issueContextMenuOpen && "bg-violet-500/[0.08] text-violet-200/80",
                )}
                disabled={!canAttachIssueContext}
                onClick={() => {
                  if (!canAttachIssueContext) return;
                  setAttachmentPickerOpen(false);
                  setIssueContextMenuOpen((open) => !open);
                }}
                aria-label="Attach issue context"
                aria-haspopup="menu"
                aria-expanded={issueContextMenuOpen}
              >
                <Bug className="h-3 w-3" size={14} weight={contextAttachmentCount ? "fill" : "regular"} />
                {contextAttachmentCount ? (
                  <span className="absolute -right-1 -top-1 inline-flex min-w-[14px] items-center justify-center rounded-full border border-violet-200/30 bg-violet-500 px-1 font-mono text-[8px] leading-[14px] text-white">
                    {contextAttachmentCount}
                  </span>
                ) : null}
              </button>
            </SmartTooltip>

            {showOrchestratorModeButton ? (
              <SmartTooltip
                forceEnabled
                content={{
                  label: orchestratorModeActive ? "Orchestrator mode" : "Start orchestrator mode",
                  description: orchestratorModeActive
                    ? "Return this draft to a normal chat."
                    : "Turn this draft into an orchestrator lead chat before sending.",
                  effect: orchestratorModeActive ? "Click to turn it off." : undefined,
                }}
              >
                <button
                  type="button"
                  data-testid="composer-orchestrator-mode-button"
                  disabled={orchestratorModeButtonDisabled}
                  onClick={() => {
                    if (orchestratorModeButtonDisabled) return;
                    if (orchestratorModeActive) {
                      onStopOrchestratorChat?.();
                      return;
                    }
                    onStartOrchestratorChat?.();
                  }}
                  className={cn(
                    "relative inline-flex h-7 min-w-7 shrink-0 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-medium transition-colors",
                    orchestratorModeActive
                      ? "border-fuchsia-300/35 bg-fuchsia-400/[0.12] text-fuchsia-100 shadow-[0_0_18px_rgba(217,70,239,0.18)]"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-fuchsia-300/22 hover:bg-fuchsia-400/[0.08] hover:text-fuchsia-100/80",
                    orchestratorModeButtonDisabled ? "cursor-not-allowed opacity-45" : "",
                  )}
                  aria-label={orchestratorModeActive ? "Orchestrator mode active" : "Start orchestrator mode"}
                  aria-pressed={orchestratorModeActive}
                >
                  <Strategy className="h-3 w-3" size={14} weight={orchestratorModeActive ? "fill" : "regular"} />
                  <span className="hidden lg:inline">Orchestrator</span>
                </button>
              </SmartTooltip>
            ) : null}

            {showParallelChatToggle && !parallelChatMode ? (
              <SmartTooltip
                forceEnabled
                content={{
                  label: "Parallel models",
                  description: "Send the same prompt and attachments to one child lane per model.",
                  effect: "Opens parallel model setup for this draft.",
                }}
              >
                <button
                  type="button"
                  disabled={turnActive || busy}
                  onClick={() => onParallelChatModeChange?.(true)}
                  className={cn(
                    "relative inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-medium transition-colors",
                    "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] hover:text-fg/60",
                    turnActive || busy ? "cursor-not-allowed opacity-40" : "",
                  )}
                  aria-label="Configure parallel models"
                >
                  <SquareSplitHorizontal className="h-3 w-3" size={14} weight="regular" />
                </button>
              </SmartTooltip>
            ) : null}

            {cursorCloudAvailable && (onOpenCloudLaunchMode || onOpenCloudBringToLocal) ? (
              <CursorCloudActionMenu
                canLaunch={cursorCloudCanLaunch}
                paneOpen={cursorCloudPaneOpen}
                launchModeOpen={cursorCloudLaunchModeOpen}
                cloudAgentId={cursorCloudAgentId}
                activeCount={cursorCloudActiveCount}
                onOpenLaunchMode={onOpenCloudLaunchMode}
                onCloseLaunchMode={onCloseCloudLaunchMode}
                onOpenBringToLocal={onOpenCloudBringToLocal}
              />
            ) : null}

            {showIosSimulatorToggle && onToggleIosSimulator ? (
              <SmartTooltip
                content={{
                  label: iosSimulatorOpen ? "Close iOS simulator" : "Open iOS simulator",
                  description: "Boot, inspect, and capture the iOS simulator alongside this chat.",
                  effect: iosSimulatorOpen ? "Hides the simulator drawer." : "Opens the simulator drawer for this lane.",
                }}
              >
                <button
                  type="button"
                  onClick={onToggleIosSimulator}
                  className={cn(
                    "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-medium transition-colors",
                    iosSimulatorOpen
                      ? "border-cyan-300/22 bg-cyan-500/10 text-cyan-100/80"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] hover:text-fg/60",
                  )}
                  aria-label={iosSimulatorOpen ? "Close iOS simulator drawer" : "Open iOS simulator drawer"}
                  aria-pressed={iosSimulatorOpen}
                >
                  <DeviceMobile className="h-3 w-3" size={14} weight={iosSimulatorOpen ? "fill" : "regular"} />
                </button>
              </SmartTooltip>
            ) : null}

            {showAppControlToggle && onToggleAppControl ? (
              <SmartTooltip
                content={{
                  label: appControlOpen ? "Close App Control" : "Open App Control",
                  description: "Launch, inspect, and capture Electron app sessions alongside this chat.",
                  effect: appControlOpen ? "Hides the App Control drawer." : "Opens App Control for this lane.",
                }}
              >
                <button
                  type="button"
                  onClick={onToggleAppControl}
                  className={cn(
                    "inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-medium transition-colors",
                    appControlOpen
                      ? "border-sky-300/22 bg-sky-500/10 text-sky-100/80"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] hover:text-fg/60",
                  )}
                  aria-label={appControlOpen ? "Close App Control drawer" : "Open App Control drawer"}
                  aria-pressed={appControlOpen}
                >
                  <Desktop className="h-3 w-3" size={14} weight={appControlOpen ? "fill" : "regular"} />
                  {appControlContextItems.length ? (
                    <span className="absolute -right-1 -top-1 inline-flex min-w-[14px] items-center justify-center rounded-full border border-sky-200/30 bg-sky-500 px-1 font-mono text-[8px] leading-[14px] text-white">
                      {appControlContextItems.length}
                    </span>
                  ) : null}
                </button>
              </SmartTooltip>
            ) : null}

            {/* Voice dictation — paired just left of the send control. */}
            {voiceInputEnabled && !composerInputLocked && !parallelChatMode ? (
              voiceModelInstalled === false ? (
                <SmartTooltip
                  forceEnabled
                  content={{
                    label: "Voice model not installed",
                    description: "Tap to download the on-device voice model in Settings → General.",
                  }}
                >
                  <button
                    type="button"
                    onClick={() => {
                      // HashRouter deep-link to the voice-input card under General.
                      window.location.hash = "#/settings?tab=general#voice-input";
                    }}
                    className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-muted-fg/30 transition-all hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_10%,transparent)] hover:text-[var(--chat-accent)] active:scale-[0.97]"
                    aria-label="Set up voice input"
                  >
                    <MicrophoneSlash size={14} weight="regular" />
                  </button>
                </SmartTooltip>
              ) : voiceModelInstalled ? (
                <VoiceDictationButton
                  onOptimisticStart={() => {
                    // This composer is the one being dictated into: claim the
                    // target and shimmer immediately, before getUserMedia.
                    registerAsDictationTarget();
                    triggerVoiceShimmer();
                  }}
                  onError={(message) => setVoiceError(message)}
                />
              ) : null
            ) : null}

            {turnActive ? (
              <>
                {draft.trim().length > 0 && onClearDraft ? (
                  <SmartTooltip content={{ label: "Clear draft", description: "Clear the unsent text without interrupting the active turn." }}>
                    <button
                      type="button"
                      className="inline-flex h-6 items-center justify-center rounded-md border border-white/[0.06] px-1.5 font-sans text-[length:calc(var(--chat-font-size)*10/14)] text-muted-fg/45 transition-all hover:bg-white/[0.04] hover:text-fg/72"
                      onClick={onClearDraft}
                    >
                      Clear
                    </button>
                  </SmartTooltip>
                ) : null}
                {(draft.trim().length > 0 || hasIosElementContext || hasAppControlContext || hasBuiltInBrowserContext || contextAttachmentCount > 0) && !composerInputLocked ? (
                  <SmartTooltip content={{ label: "Send steer message", description: "Queue this message for the running chat after the current turn finishes." }}>
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-full bg-white/90 text-zinc-900 transition-all hover:bg-white active:scale-[0.97]"
                      onClick={submitComposerDraft}
                      aria-label="Send steer message"
                    >
                      <ArrowUp size={14} weight="bold" />
                    </button>
                  </SmartTooltip>
                ) : null}
                <SmartTooltip content={{ label: "Stop active turn", description: "Interrupt only the current model turn for this chat.", shortcut: `${modifierKeyLabel}+.` }}>
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-red-500/25 bg-red-500/[0.08] text-red-400/80 transition-all hover:border-red-500/40 hover:bg-red-500/[0.14] hover:text-red-400"
                    aria-label="Stop active turn"
                    onClick={onInterrupt}
                  >
                    <Square size={9} weight="fill" />
                  </button>
                </SmartTooltip>
              </>
            ) : (
              (() => {
                // Switch the Send button to its cloud variant only when the chat is fresh enough
                // to actually launch a new cloud run. Once turns exist, the launch path is closed
                // and we keep the standard local Send affordance even if the cloud pane is open.
                const cloudMode = cursorCloudAvailable
                  && cursorCloudCanLaunch
                  && cursorCloudLaunchModeOpen
                  && !parallelChatMode;
                const label = parallelChatMode
                  ? "Send to lanes"
                  : cloudMode
                    ? "Send to Cursor Cloud"
                    : "Send";
                const description = parallelChatMode
                  ? "Create child lanes and send this prompt with its attachments to every configured model."
                  : cloudMode
                    ? "Launch a Cursor Cloud agent with this prompt and the panel's settings."
                    : "Send this prompt to the selected model.";
                return (
                  <>
                    <SmartTooltip forceEnabled content={{ label, description, effect: sendButtonTitle() }}>
                      <button
                        type="button"
                        className={cn(
                          "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-all active:scale-[0.97]",
                          sendEnabled
                            ? "bg-white/90 text-zinc-900 hover:bg-white"
                            : "bg-white/[0.06] text-muted-fg/20",
                        )}
                        disabled={!sendEnabled}
                        onClick={submitComposerDraft}
                        aria-label={label}
                      >
                        {cloudMode
                          ? <CloudArrowUp size={14} weight="bold" />
                          : <ArrowUp size={14} weight="bold" />}
                      </button>
                    </SmartTooltip>
                    {onSubmitInBackground && !parallelChatMode && !cloudMode ? (
                      <SmartTooltip forceEnabled content={{ label: backgroundLaunchActionLabel, description: "Start this chat without leaving the new chat pane." }}>
                        <button
                          type="button"
                          className={cn(
                            "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-all active:scale-[0.97]",
                            backgroundSendEnabled
                              ? "border-emerald-300/25 bg-emerald-500/[0.12] text-emerald-100 hover:border-emerald-300/40 hover:bg-emerald-500/[0.18]"
                              : "border-white/[0.04] bg-white/[0.02] text-muted-fg/15",
                          )}
                          disabled={!backgroundSendEnabled}
                          onClick={onSubmitInBackground}
                          aria-label={backgroundLaunchBusy ? "Launching" : backgroundLaunchActionLabel}
                        >
                          <RocketLaunch size={14} weight="fill" />
                        </button>
                      </SmartTooltip>
                    ) : null}
                  </>
                );
              })()
            )}
          </div>
          </div>
        </div>
      }
    >
      {cursorCloudLaunchModeOpen && cursorCloudLaunchPanel ? (
        <div className="border-b border-violet-300/[0.10] bg-violet-500/[0.04] px-3 py-3">
          {cursorCloudLaunchPanel}
        </div>
      ) : null}
      {/* Pending steers queue — shows queued messages above the input */}
      {pendingSteers.length > 0 ? (
        <div className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 space-y-1.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[length:calc(var(--chat-font-size)*9/14)] uppercase tracking-[0.16em] text-fg/30">
              Staged {pendingSteers.length === 1 ? "message" : `messages (${pendingSteers.length})`}
            </span>
            <span className="font-sans text-[length:calc(var(--chat-font-size)*9/14)] text-fg/30">
              Hover to send now, interrupt, edit, or remove.
            </span>
          </div>
          {pendingSteers.map((steer) => (
            <PendingSteerItem
              key={steer.steerId}
              steer={steer}
              onCancel={() => onCancelSteer?.(steer.steerId)}
              onEdit={(text) => onEditSteer?.(steer.steerId, text)}
              onSendNow={onDispatchSteerInline ? () => onDispatchSteerInline(steer.steerId) : undefined}
              onInterrupt={onDispatchSteerInterrupt ? () => onDispatchSteerInterrupt(steer.steerId) : undefined}
            />
          ))}
        </div>
      ) : null}

      <div
        className="relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragActive ? (
          <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,rgba(5,5,8,0.58))] backdrop-blur-sm">
            <div className="rounded-[var(--chat-radius-card)] border border-[color:color-mix(in_srgb,var(--chat-accent)_32%,transparent)] bg-card/92 px-5 py-4 text-center shadow-[var(--chat-composer-shadow)]">
              <div className="font-mono text-[length:calc(var(--chat-font-size)*10/14)] uppercase tracking-[0.18em] text-[var(--chat-accent)]">
                Drop files to attach
              </div>
              <div className="mt-1 text-[length:calc(var(--chat-font-size)*12/14)] text-fg/74">
                {parallelChatMode
                  ? `Up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files, sent to every parallel lane.`
                  : "Images and files will be added to this turn."}
              </div>
            </div>
          </div>
        ) : null}

        <div
          className={cn("relative", voiceShimmer ? "ade-voice-shimmer" : "")}
          onFocusCapture={() => {
            // Focusing this composer makes it the dictation insertion target so
            // a transcript lands in whichever composer the user is typing into.
            registerAsDictationTarget();
          }}
        >
          <ChatCommandMenu
            ref={commandMenuRef}
            trigger={commandMenuTrigger}
            slashCommands={effectiveSlashCommands.map((c) => ({
              name: c.command.replace(/^\//, ""),
              description: c.description,
              argumentHint: c.argumentHint,
              source: c.source,
            }))}
            onFileSearch={onSearchAttachments}
            anchor={commandMenuAnchor}
            onSelect={handleCommandMenuSelect}
            onClose={() => setCommandMenuTrigger(null)}
          />
          {useRichComposer ? (
            <div className="relative">
              {!draft.trim().length && !iosElementContextItems.length && !appControlContextItems.length && !builtInBrowserContextItems.length ? (
                <div className="pointer-events-none absolute left-4 top-2.5 font-sans text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6] text-muted-fg/30">
                  {composerInputLockMessage ?? (turnActive ? "Steer the active turn..." : (promptSuggestion || messagePlaceholder || "Type to vibecode..."))}
                </div>
              ) : null}
              <div
                ref={richEditorRef}
                contentEditable={!parallelLaunchBusy && !composerInputLocked}
                role="textbox"
                aria-multiline="true"
                aria-label={composerInputAccessibleLabel}
                suppressContentEditableWarning
                className={cn(
                  "block max-h-[200px] min-h-[2.6rem] w-full overflow-auto whitespace-pre-wrap break-words bg-transparent px-4 py-2.5 font-sans text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6] text-fg/88 outline-none transition-colors",
                  dragActive ? "opacity-30" : "",
                  parallelLaunchBusy || composerInputLocked ? "cursor-not-allowed opacity-50" : "",
                )}
                data-chat-layout-variant={layoutVariant}
                onInput={handleRichEditorInput}
                onCompositionStart={() => {
                  imeComposingRef.current = true;
                }}
                onCompositionEnd={() => {
                  imeComposingRef.current = false;
                  handleRichEditorInput();
                }}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onKeyUp={captureRichSelection}
                onMouseUp={captureRichSelection}
                onBlur={captureRichSelection}
                onClick={(event) => {
                  const target = event.target as HTMLElement | null;
                  const iosChip = target?.closest?.("[data-ios-context-id]") as HTMLElement | null;
                  if (iosChip?.dataset.iosContextId) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (target?.dataset.iosRemove === "true") {
                      onRemoveIosElementContext?.(iosChip.dataset.iosContextId);
                      return;
                    }
                    setSelectedIosContextId((current) => current === iosChip.dataset.iosContextId ? null : iosChip.dataset.iosContextId ?? null);
                    setSelectedAppControlContextId(null);
                    setSelectedBuiltInBrowserContextId(null);
                    return;
                  }
                  const appControlChip = target?.closest?.("[data-app-control-context-id]") as HTMLElement | null;
                  if (appControlChip?.dataset.appControlContextId) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (target?.dataset.appControlRemove === "true") {
                      onRemoveAppControlContext?.(appControlChip.dataset.appControlContextId);
                      return;
                    }
                    setSelectedAppControlContextId((current) =>
                      current === appControlChip.dataset.appControlContextId ? null : appControlChip.dataset.appControlContextId ?? null,
                    );
                    setSelectedIosContextId(null);
                    setSelectedBuiltInBrowserContextId(null);
                    return;
                  }
                  const builtInBrowserChip = target?.closest?.("[data-built-in-browser-context-id]") as HTMLElement | null;
                  if (builtInBrowserChip?.dataset.builtInBrowserContextId) {
                    event.preventDefault();
                    event.stopPropagation();
                    if (target?.dataset.builtInBrowserRemove === "true") {
                      onRemoveBuiltInBrowserContext?.(builtInBrowserChip.dataset.builtInBrowserContextId);
                      return;
                    }
                    setSelectedBuiltInBrowserContextId((current) =>
                      current === builtInBrowserChip.dataset.builtInBrowserContextId ? null : builtInBrowserChip.dataset.builtInBrowserContextId ?? null,
                    );
                    setSelectedIosContextId(null);
                    setSelectedAppControlContextId(null);
                    return;
                  }
                }}
              />
            </div>
          ) : (
            <div className="relative">
              {plainOverlayContent ? (
                <div aria-hidden className="pointer-events-none absolute inset-0 overflow-hidden">
                  <div
                    className={cn(
                      "whitespace-pre-wrap break-words px-4 py-2.5 text-left text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6] text-fg/88",
                      dragActive ? "opacity-30" : "",
                      parallelLaunchBusy || composerInputLocked ? "opacity-50" : "",
                    )}
                    style={{ transform: `translateY(-${plainOverlayScrollTop}px)` }}
                  >
                    {plainOverlayContent}
                  </div>
                </div>
              ) : null}
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(event) => {
                  const val = event.target.value;
                  onDraftChange(val);
                  const cursorPos = event.target.selectionStart ?? val.length;
                  lastPlainSelectionRef.current = cursorPos;
                  if (imeComposingRef.current) return;
                  evaluatePlainTrigger(event.currentTarget, cursorPos, true);
                }}
                rows={1}
                onInput={resizeTextarea}
                onScroll={(event) => {
                  if (plainComposerTokens.length) setPlainOverlayScrollTop(event.currentTarget.scrollTop);
                }}
                onCompositionStart={() => {
                  imeComposingRef.current = true;
                }}
                onCompositionEnd={(event) => {
                  imeComposingRef.current = false;
                  const node = event.currentTarget;
                  evaluatePlainTrigger(node, node.selectionStart ?? node.value.length, true);
                }}
                onSelect={(event) => {
                  const node = event.currentTarget;
                  const caret = node.selectionStart ?? node.value.length;
                  lastPlainSelectionRef.current = caret;
                  if (imeComposingRef.current) return;
                  evaluatePlainTrigger(node, caret, false);
                }}
                disabled={parallelLaunchBusy || composerInputLocked}
                autoComplete="on"
                autoCorrect="on"
                autoCapitalize="sentences"
                spellCheck={true}
                aria-label={composerInputAccessibleLabel}
                className={cn(
                  "block w-full resize-none bg-transparent px-4 py-2.5 text-left text-[length:calc(var(--chat-font-size)*13/14)] leading-[1.6] text-fg/88 outline-none transition-colors placeholder:text-muted-fg/30",
                  plainOverlayContent ? "relative z-[1] text-transparent" : "",
                  dragActive ? "opacity-30" : "",
                  parallelLaunchBusy || composerInputLocked ? "cursor-not-allowed opacity-50" : "",
                )}
                style={plainOverlayContent ? { caretColor: "var(--color-fg)" } : undefined}
                data-chat-layout-variant={layoutVariant}
                placeholder={composerInputLockMessage ?? (turnActive ? "Steer the active turn..." : (promptSuggestion || messagePlaceholder || "Type to vibecode..."))}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
            </div>
          )}
        </div>
      </div>
      </ChatComposerShell>
      </BorderBeam>
    </>
  );
}

function CursorCloudActionMenu({
  canLaunch,
  paneOpen,
  launchModeOpen,
  cloudAgentId,
  activeCount,
  onOpenLaunchMode,
  onCloseLaunchMode,
  onOpenBringToLocal,
}: {
  /**
   * Whether the "Send to Cursor Cloud" launch item should be available. The trigger button itself
   * is always shown (so users can always reach "Open existing cloud chat") but the launch row is
   * only useful for fresh chats with no exchanged turns.
   */
  canLaunch: boolean;
  paneOpen: boolean;
  launchModeOpen: boolean;
  cloudAgentId: string | null;
  activeCount: number;
  onOpenLaunchMode?: () => void;
  onCloseLaunchMode?: () => void;
  onOpenBringToLocal?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuPos, setMenuPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const recalc = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const menuWidth = 280;
      const gap = 8;
      const top = Math.max(8, rect.top - gap);
      const left = Math.min(window.innerWidth - menuWidth - 8, Math.max(8, rect.right - menuWidth));
      setMenuPos({ left, top });
    };
    recalc();
    window.addEventListener("resize", recalc);
    window.addEventListener("scroll", recalc, true);
    return () => {
      window.removeEventListener("resize", recalc);
      window.removeEventListener("scroll", recalc, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handle = (event: MouseEvent) => {
      const target = event.target as Node;
      if (wrapRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", handle);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", handle);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const active = paneOpen || launchModeOpen;
  return (
    <div ref={wrapRef} className="relative">
      <SmartTooltip
        content={{
          label: "Cursor Cloud",
          description: "Send this prompt to Cursor Cloud or resume a cloud chat locally.",
          effect: cloudAgentId ? "This chat is promoted to cloud." : undefined,
        }}
      >
        <button
          type="button"
          ref={triggerRef}
          onClick={() => setOpen((v) => !v)}
          className={cn(
            "relative inline-flex h-7 min-w-7 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[length:calc(var(--chat-font-size)*9/14)] font-medium transition-colors",
            active
              ? "border-violet-300/30 bg-violet-500/[0.16] text-violet-100/90"
              : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-violet-300/22 hover:text-violet-200/80",
          )}
          aria-label="Cursor Cloud actions"
          aria-haspopup="menu"
          aria-expanded={open}
        >
          <CloudArrowUp className="h-3 w-3" size={14} weight={active ? "fill" : "regular"} />
          {activeCount > 0 ? (
            <span className="absolute -right-1 -top-1 inline-flex h-[13px] min-w-[13px] items-center justify-center rounded-full border border-black/30 px-0.5 font-mono text-[8px] font-bold text-black" style={{ background: "#A78BFA" }}>{activeCount}</span>
          ) : cloudAgentId ? (
            <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full border border-black/40" style={{ background: "#A78BFA" }} aria-hidden />
          ) : null}
        </button>
      </SmartTooltip>
      {open && menuPos ? createPortal(
        <div
          ref={menuRef}
          role="menu"
          style={{ left: menuPos.left, top: menuPos.top, transform: "translateY(-100%)", width: 280 }}
          className="fixed z-[1000] overflow-hidden rounded-lg border border-white/[0.08] bg-[color:color-mix(in_srgb,var(--chat-panel-bg-strong)_94%,black_6%)] shadow-[0_18px_48px_rgba(0,0,0,0.48)] backdrop-blur-xl"
        >
          {canLaunch ? (
            <>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); if (launchModeOpen) onCloseLaunchMode?.(); else onOpenLaunchMode?.(); }}
                className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-violet-500/[0.10]"
              >
                <CloudArrowUp size={14} weight="fill" className="mt-0.5 shrink-0 text-violet-300" />
                <span className="min-w-0 flex-1">
                  <span className="block font-sans text-[12px] font-semibold text-fg/90">{launchModeOpen ? "Cancel cloud send" : "Send to Cursor Cloud"}</span>
                  <span className="block font-sans text-[10.5px] leading-snug text-fg/45">{launchModeOpen ? "Hide the cloud launch options." : "Pick a repo, branch, model — then send your prompt to a fresh cloud agent."}</span>
                </span>
              </button>
              <div className="h-px bg-white/[0.05]" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            onClick={() => { setOpen(false); onOpenBringToLocal?.(); }}
            className="flex w-full items-start gap-2.5 px-3 py-2.5 text-left transition-colors hover:bg-violet-500/[0.10]"
          >
            <ArrowBendDownRight size={14} weight="bold" className="mt-0.5 shrink-0 text-violet-300/85" />
            <span className="min-w-0 flex-1">
              <span className="block font-sans text-[12px] font-semibold text-fg/90">Open existing cloud chat</span>
              <span className="block font-sans text-[10.5px] leading-snug text-fg/45">Browse your Cursor Cloud agents and open one as a chat in ADE.</span>
            </span>
          </button>
        </div>,
        document.body,
      ) : null}
    </div>
  );
}
