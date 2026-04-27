import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { At, CaretDown, Check, Image, Paperclip, PencilSimple, Square, X, PaperPlaneTilt, Cube, SquareSplitHorizontal, Plus, Trash, Lightning, ArrowBendDownRight } from "@phosphor-icons/react";
import { BorderBeam } from "border-beam";
import {
  inferAttachmentType,
  PARALLEL_CHAT_MAX_ATTACHMENTS,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCursorConfigOption,
  type AgentChatCursorModeSnapshot,
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
  type PendingInputRequest,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { ProviderModelSelector } from "../shared/ProviderModelSelector";
import { getPermissionOptions, safetyColors } from "../shared/permissionOptions";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { ChatComposerShell } from "./ChatComposerShell";
import { getPendingInputQuestionCount, hasPendingInputOptions } from "./pendingInput";
import { CURSOR_MODE_LABELS } from "../../../shared/cursorModes";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { ChatProposedPlanCard } from "./ChatProposedPlanCard";
import { ChatCommandMenu, type ChatCommandMenuItem, type ChatCommandMenuHandle } from "./ChatCommandMenu";
import { modifierKeyLabel } from "../../lib/platform";
import { SmartTooltip } from "../ui/SmartTooltip";

const MAX_TEMP_ATTACHMENT_BYTES = 10 * 1024 * 1024;

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

/** When set, permission/runtime controls bind to this slot (parallel model row configuration). */
export type ParallelComposerControlSlot = {
  sessionProvider: string;
  interactionMode: AgentChatInteractionMode;
  claudePermissionMode: AgentChatClaudePermissionMode;
  codexApprovalPolicy: AgentChatCodexApprovalPolicy;
  codexSandbox: AgentChatCodexSandbox;
  codexConfigSource: AgentChatCodexConfigSource;
  opencodePermissionMode: AgentChatOpenCodePermissionMode;
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
  onCursorModeChange: (modeId: string) => void;
  onCursorConfigChange: (configId: string, value: string | boolean) => void;
};

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

type ClaudeModeTone = "green" | "blue" | "purple" | "red";

type ClaudeModeOption = {
  value: AgentChatClaudePermissionMode;
  label: string;
  detail: string;
  tone: ClaudeModeTone;
};

const CLAUDE_MODE_OPTIONS: ClaudeModeOption[] = [
  { value: "default", label: "Ask permissions", detail: "Claude asks before edits, Bash, and other sensitive tools.", tone: "green" },
  { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved; higher-risk actions still prompt.", tone: "blue" },
  { value: "plan", label: "Plan mode", detail: "Read-only Claude turns for analysis and implementation planning.", tone: "purple" },
  { value: "bypassPermissions", label: "Bypass permissions", detail: "Skip every Claude permission prompt for this chat.", tone: "red" },
];

const CLAUDE_MODE_TONE_STYLES: Record<
  ClaudeModeTone,
  {
    activeBg: string;
    activeText: string;
    activeBorder: string;
    dot: string;
    hoverBg: string;
  }
> = {
  green: {
    activeBg: "bg-emerald-500/12",
    activeText: "text-emerald-200",
    activeBorder: "border-emerald-500/35",
    dot: "bg-emerald-400",
    hoverBg: "hover:bg-emerald-500/10 hover:text-emerald-100",
  },
  blue: {
    activeBg: "bg-sky-500/14",
    activeText: "text-sky-200",
    activeBorder: "border-sky-500/35",
    dot: "bg-sky-400",
    hoverBg: "hover:bg-sky-500/10 hover:text-sky-100",
  },
  purple: {
    activeBg: "bg-violet-500/14",
    activeText: "text-violet-200",
    activeBorder: "border-violet-500/35",
    dot: "bg-violet-400",
    hoverBg: "hover:bg-violet-500/10 hover:text-violet-100",
  },
  red: {
    activeBg: "bg-red-500/14",
    activeText: "text-red-200",
    activeBorder: "border-red-500/35",
    dot: "bg-red-400",
    hoverBg: "hover:bg-red-500/10 hover:text-red-100",
  },
};

type CodexPermissionPreset = "default" | "plan" | "full-auto" | "config-toml" | "custom";

function resolveCodexPermissionPreset(args: {
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
}): CodexPermissionPreset {
  if (args.codexConfigSource === "config-toml") return "config-toml";
  if ((args.codexApprovalPolicy === "on-request" || args.codexApprovalPolicy === "untrusted" || args.codexApprovalPolicy === "on-failure") && args.codexSandbox === "workspace-write") return "default";
  if ((args.codexApprovalPolicy === "on-request" || args.codexApprovalPolicy === "untrusted") && args.codexSandbox === "read-only") return "plan";
  if (args.codexApprovalPolicy === "never" && args.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

const OPENCODE_PERMISSION_OPTIONS: Array<{ value: AgentChatOpenCodePermissionMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
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
            className="w-full resize-none rounded border border-white/[0.08] bg-white/[0.04] px-2 py-1 text-[12px] leading-[1.5] text-fg/82 outline-none focus:border-[var(--chat-accent)]/30"
            rows={1}
          />
          <div className="mt-1 flex gap-1">
            <button
              type="button"
              onClick={commitEdit}
              className="inline-flex h-5 items-center gap-0.5 rounded border border-[var(--chat-accent)]/20 bg-[var(--chat-accent)]/8 px-1.5 text-[9px] font-medium text-[var(--chat-accent)] hover:bg-[var(--chat-accent)]/14"
            >
              <Check size={9} weight="bold" /> Save
            </button>
            <button
              type="button"
              onClick={cancelEdit}
              className="inline-flex h-5 items-center rounded border border-white/[0.06] px-1.5 text-[9px] text-fg/40 hover:text-fg/60"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[9px] uppercase tracking-[0.14em] text-[var(--chat-accent)]/60">
            Sends after turn
          </div>
          <div className="truncate text-[12px] leading-[1.5] text-fg/62">
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
  reasoningEffort,
  draft,
  attachments,
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
  cursorModeSnapshot,
  executionMode,
  computerUseSnapshot,
  proofOpen = false,
  proofArtifactCount = 0,
  executionModeOptions = [],
  modelSelectionLocked = false,
  permissionModeLocked = false,
  hideNativeControls = false,
  messagePlaceholder,
  onModelChange,
  onReasoningEffortChange,
  onDraftChange,
  onClearDraft,
  onSubmit,
  onInterrupt,
  onApproval,
  onAddAttachment,
  onRemoveAttachment,
  onSearchAttachments,
  onExecutionModeChange,
  onInteractionModeChange,
  onClaudeModeChange,
  onClaudePermissionModeChange,
  onCodexPresetChange,
  onCodexApprovalPolicyChange,
  onCodexSandboxChange,
  onCodexConfigSourceChange,
  onOpenCodePermissionModeChange,
  onCursorModeChange,
  onCursorConfigChange,
  onToggleProof,
  onClearEvents,
  promptSuggestion,
  chatHasMessages = false,
  pendingSteers = [],
  onCancelSteer,
  onEditSteer,
  onDispatchSteerInline,
  onDispatchSteerInterrupt,
  onOpenAiSettings,
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
  parallelLaunchBusy = false,
  parallelLaunchStatus = null,
  parallelControlSlot = null,
  parallelSlotExecutionModeOptions = [],
  parallelSlotExecutionMode = null,
  onParallelSlotExecutionModeChange,
  showParallelChatToggle = false,
}: {
  surfaceMode?: ChatSurfaceMode;
  layoutVariant?: "standard" | "grid-tile";
  composerMaxHeightPx?: number | null;
  isActive?: boolean;
  shouldAutofocus?: boolean;
  sdkSlashCommands?: AgentChatSlashCommand[];
  modelId: string;
  availableModelIds?: string[];
  reasoningEffort: string | null;
  draft: string;
  attachments: AgentChatFileRef[];
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
  cursorModeSnapshot?: AgentChatCursorModeSnapshot | null;
  executionMode?: AgentChatExecutionMode | null;
  computerUseSnapshot?: ComputerUseOwnerSnapshot | null;
  proofOpen?: boolean;
  proofArtifactCount?: number;
  executionModeOptions?: ExecutionModeOption[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
  hideNativeControls?: boolean;
  messagePlaceholder?: string;
  onModelChange: (modelId: string) => void;
  onReasoningEffortChange: (reasoningEffort: string | null) => void;
  onDraftChange: (value: string) => void;
  onClearDraft?: () => void;
  onSubmit: () => void;
  onInterrupt: () => void;
  onApproval: (decision: AgentChatApprovalDecision, responseText?: string | null) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
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
  onCursorModeChange?: (modeId: string) => void;
  onCursorConfigChange?: (configId: string, value: string | boolean) => void;
  onComputerUsePolicyChange?: (policy: unknown) => void;
  onToggleProof?: () => void;
  onClearEvents?: () => void;
  promptSuggestion?: string | null;
  chatHasMessages?: boolean;
  pendingSteers?: Array<{ steerId: string; text: string }>;
  onCancelSteer?: (steerId: string) => void;
  onEditSteer?: (steerId: string, text: string) => void;
  onDispatchSteerInline?: (steerId: string) => void;
  onDispatchSteerInterrupt?: (steerId: string) => void;
  onOpenAiSettings?: () => void;
  sessionId?: string | null;
  parallelChatMode?: boolean;
  onParallelChatModeChange?: (enabled: boolean) => void;
  parallelModelSlots?: Array<{ modelId: string; reasoningEffort: string | null }>;
  parallelConfiguringIndex?: number | null;
  onParallelConfiguringIndexChange?: (index: number | null) => void;
  onParallelAddModel?: () => void;
  onParallelRemoveModel?: (index: number) => void;
  onParallelSlotModelChange?: (index: number, modelId: string) => void;
  onParallelSlotReasoningChange?: (index: number, effort: string | null) => void;
  parallelLaunchBusy?: boolean;
  parallelLaunchStatus?: string | null;
  parallelControlSlot?: ParallelComposerControlSlot | null;
  parallelSlotExecutionModeOptions?: ExecutionModeOption[];
  parallelSlotExecutionMode?: AgentChatExecutionMode | null;
  onParallelSlotExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  showParallelChatToggle?: boolean;
}) {
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentResults, setAttachmentResults] = useState<AgentChatFileRef[]>([]);
  const [attachmentCursor, setAttachmentCursor] = useState(0);
  const [attachError, setAttachError] = useState<string | null>(null);

  const [hoveredClaudeMode, setHoveredClaudeMode] = useState<AgentChatClaudePermissionMode | null>(null);
  const [hoveredCodexPreset, setHoveredCodexPreset] = useState<Exclude<CodexPermissionPreset, "custom"> | null>(null);
  const [claudeModePickerOpen, setClaudeModePickerOpen] = useState(false);
  const claudeModePickerRef = useRef<HTMLDivElement | null>(null);
  const [codexPresetPickerOpen, setCodexPresetPickerOpen] = useState(false);
  const codexPresetPickerRef = useRef<HTMLDivElement | null>(null);

  const [dragActive, setDragActive] = useState(false);
  const [commandMenuTrigger, setCommandMenuTrigger] = useState<{ type: "at" | "slash"; query: string; cursorIndex: number } | null>(null);
  const [commandMenuAnchor, setCommandMenuAnchor] = useState<{ top: number; left: number } | null>(null);
  const commandMenuRef = useRef<ChatCommandMenuHandle | null>(null);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileAddInProgressRef = useRef(false);
  const canAttach = !parallelChatMode || attachments.length < PARALLEL_CHAT_MAX_ATTACHMENTS;
  const attachBlockedReason = parallelChatMode && attachments.length >= PARALLEL_CHAT_MAX_ATTACHMENTS
    ? `Maximum ${PARALLEL_CHAT_MAX_ATTACHMENTS} attachments for parallel launch`
    : null;

  const resizeTextarea = useCallback(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "0px";
    const maxH = layoutVariant === "grid-tile" ? (composerMaxHeightPx ?? 200) : 200;
    const next = Math.min(Math.max(el.scrollHeight, 28), maxH);
    el.style.height = `${next}px`;
    el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
  }, [layoutVariant, composerMaxHeightPx]);
  useEffect(() => {
    resizeTextarea();
    if (!shouldAutofocus) return;
    textareaRef.current?.focus({ preventScroll: true });
  }, [resizeTextarea, shouldAutofocus]);
  useLayoutEffect(() => {
    resizeTextarea();
  }, [draft, resizeTextarea]);

  const attachedPaths = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const effectiveSlashCommands = useMemo(
    () => buildSlashCommands(sdkSlashCommands, { includeLocalClear: typeof onClearEvents === "function" }),
    [sdkSlashCommands, onClearEvents],
  );

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
    if (parallelChatMode && attachments.length >= PARALLEL_CHAT_MAX_ATTACHMENTS) {
      setAttachError(`You can attach up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files for parallel launch.`);
      return;
    }
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  const addFileAttachments = async (files: FileList | null | undefined) => {
    if (!files?.length) return;
    if (turnActive) return;
    if (parallelChatMode && attachments.length >= PARALLEL_CHAT_MAX_ATTACHMENTS) return;
    if (fileAddInProgressRef.current) return;
    fileAddInProgressRef.current = true;
    setAttachError(null);
    try {
      let addedInBatch = 0;
      for (const file of Array.from(files)) {
        if (parallelChatMode && attachments.length + addedInBatch >= PARALLEL_CHAT_MAX_ATTACHMENTS) {
          setAttachError(`You can attach up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files for parallel launch.`);
          break;
        }
        const fileWithPath = file as File & { path?: string };
        const hasRealPath = typeof fileWithPath.path === "string" && fileWithPath.path.trim().length > 0;

        if (hasRealPath) {
          const filePath = fileWithPath.path!;
          onAddAttachment({ path: filePath, type: inferAttachmentType(filePath, file.type) });
          addedInBatch += 1;
          continue;
        }

        if (file.size > MAX_TEMP_ATTACHMENT_BYTES) {
          setAttachError(
            `File "${file.name || "clipboard"}" is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
          );
          continue;
        }

        try {
          const buf = await file.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let binary = "";
          for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
          const base64 = btoa(binary);
          const { path: tempPath } = await window.ade.agentChat.saveTempAttachment({
            data: base64,
            filename: file.name || "clipboard.png",
          });
          onAddAttachment({ path: tempPath, type: inferAttachmentType(tempPath, file.type) });
          addedInBatch += 1;
        } catch {
          setAttachError(`Unable to attach "${file.name || "clipboard"}".`);
        }
      }
    } finally {
      fileAddInProgressRef.current = false;
    }
  };

  const handleSlashSelect = useCallback((cmd: SlashCommandEntry) => {
    // Local-only commands handled client-side
    if (cmd.command === "/clear" && cmd.source === "local" && onClearEvents) { onClearEvents(); onDraftChange(""); return; }
    // SDK and all other commands: set as draft text to be sent to the agent
    const suffix = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
    onDraftChange(`${cmd.command}${suffix} `);
  }, [onClearEvents, onDraftChange]);

  const nativeControlsDisabled = permissionModeLocked;
  const slot = parallelControlSlot;
  const sp = slot?.sessionProvider ?? sessionProvider ?? "opencode";
  const im = slot?.interactionMode ?? interactionMode ?? "default";
  const cpmUse = slot?.claudePermissionMode ?? claudePermissionMode;
  const capUse = slot?.codexApprovalPolicy ?? codexApprovalPolicy;
  const csUse = slot?.codexSandbox ?? codexSandbox;
  const ccsUse = slot?.codexConfigSource ?? codexConfigSource;
  const opmUse = slot?.opencodePermissionMode ?? opencodePermissionMode;
  const cmsUse = slot?.cursorModeSnapshot ?? cursorModeSnapshot;

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
      .filter((option) => option.value === "default" || option.value === "plan" || option.value === "full-auto" || option.value === "config-toml"),
    [],
  );
  const applyCodexPreset = useCallback((preset: Exclude<CodexPermissionPreset, "custom">) => {
    const next = preset === "default"
      ? {
          codexApprovalPolicy: "on-request" as const,
          codexSandbox: "workspace-write" as const,
          codexConfigSource: "flags" as const,
        }
      : preset === "plan"
      ? {
          codexApprovalPolicy: "on-request" as const,
          codexSandbox: "read-only" as const,
          codexConfigSource: "flags" as const,
        }
      : preset === "config-toml"
        ? {
            codexApprovalPolicy: codexApprovalPolicy ?? "on-request",
            codexSandbox: codexSandbox ?? "workspace-write",
            codexConfigSource: "config-toml" as const,
          }
        : {
            codexApprovalPolicy: "never" as const,
            codexSandbox: "danger-full-access" as const,
            codexConfigSource: "flags" as const,
          };

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
  const claudeControlDetail = useMemo(() => {
    if (sp !== "claude") return null;
    const option = CLAUDE_MODE_OPTIONS.find((item) => item.value === (hoveredClaudeMode ?? claudeSelectionMode));
    return option?.detail ?? null;
  }, [claudeSelectionMode, hoveredClaudeMode, sp]);

  useEffect(() => {
    if (!codexPresetPickerOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!codexPresetPickerRef.current) return;
      if (codexPresetPickerRef.current.contains(event.target as Node)) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-codex-preset-picker-dropdown]")) return;
      setCodexPresetPickerOpen(false);
      setHoveredCodexPreset(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setCodexPresetPickerOpen(false);
        setHoveredCodexPreset(null);
      }
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [codexPresetPickerOpen]);

  useEffect(() => {
    if (!claudeModePickerOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (!claudeModePickerRef.current) return;
      if (claudeModePickerRef.current.contains(event.target as Node)) return;
      const target = event.target as Element | null;
      if (target?.closest?.("[data-claude-mode-picker-dropdown]")) return;
      setClaudeModePickerOpen(false);
      setHoveredClaudeMode(null);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setClaudeModePickerOpen(false);
        setHoveredClaudeMode(null);
      }
    };
    window.addEventListener("mousedown", handleClick);
    window.addEventListener("keydown", handleKey);
    return () => {
      window.removeEventListener("mousedown", handleClick);
      window.removeEventListener("keydown", handleKey);
    };
  }, [claudeModePickerOpen]);
  const codexCustomSummary = useMemo(() => {
    if (sp !== "codex" || codexPreset !== "custom") return null;
    if (ccsUse === "config-toml") {
      return "Custom Codex mode: config.toml controls approval and sandbox.";
    }
    const approvalLabel = {
      "untrusted": "Untrusted",
      "on-request": "On request",
      "on-failure": "On failure",
      "never": "Never",
    }[capUse ?? "on-request"];
    const sandboxLabel = {
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Danger full access",
    }[csUse ?? "workspace-write"];
    return `Custom Codex mode: ${ccsUse === "flags" ? "ADE flags" : "config.toml"} - ${approvalLabel} - ${sandboxLabel}`;
  }, [capUse, ccsUse, codexPreset, csUse, sp]);
  const codexControlDetail = useMemo(() => {
    if (sp !== "codex") return null;
    if (hoveredCodexPreset) {
      return codexPresetOptions.find((option) => option.value === hoveredCodexPreset)?.detail ?? null;
    }
    if (codexPreset === "custom") {
      return codexCustomSummary;
    }
    return codexPresetOptions.find((option) => option.value === codexPreset)?.detail ?? null;
  }, [codexCustomSummary, codexPreset, codexPresetOptions, hoveredCodexPreset, sp]);
  const nativeControlPanel = useMemo(() => {
    if (hideNativeControls) {
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

    const renderButtonGroup = <T extends string,>(
      label: string,
      value: T | undefined,
      options: Array<{ value: T; label: string; detail: string; safety?: "safe" | "semi-auto" | "danger" }>,
      onChange: ((value: T) => void) | undefined,
      disabled = false,
      onHoverChange?: (value: T | null) => void,
    ) => (
      <div className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">{label}</span>
        <div className="flex items-center gap-px rounded-md border border-white/[0.06] bg-[#14141b] p-0.5">
          {options.map((option) => {
            const active = value === option.value;
            const colors = option.safety ? safetyColors(option.safety) : null;
            return (
              <SmartTooltip
                key={option.value}
                content={{
                  label: option.label,
                  description: option.detail,
                  effect: active ? "Currently selected." : undefined,
                }}
              >
                <button
                  type="button"
                  className={cn(
                    "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                    active
                      ? (colors ? `${colors.activeBg} text-fg/80` : "bg-white/[0.08] text-fg/80")
                      : "text-muted-fg/35 hover:text-muted-fg/60",
                    disabled ? "cursor-not-allowed opacity-50" : "",
                  )}
                  disabled={disabled || !onChange}
                  onClick={() => onChange?.(option.value)}
                  onMouseEnter={() => onHoverChange?.(option.value)}
                  onMouseLeave={() => onHoverChange?.(null)}
                  onFocus={() => onHoverChange?.(option.value)}
                  onBlur={() => onHoverChange?.(null)}
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              </SmartTooltip>
            );
          })}
        </div>
      </div>
    );

    if (sp === "claude") {
      const selectedOption =
        CLAUDE_MODE_OPTIONS.find((option) => option.value === claudeSelectionMode) ?? CLAUDE_MODE_OPTIONS[0];
      const selectedTone = CLAUDE_MODE_TONE_STYLES[selectedOption.tone];
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
          <div ref={claudeModePickerRef} className="relative">
            <button
              type="button"
              aria-haspopup="listbox"
              aria-expanded={claudeModePickerOpen}
              aria-label="Claude permission mode"
              disabled={nativeControlsDisabled}
              onClick={() => {
                if (nativeControlsDisabled) return;
                setClaudeModePickerOpen((open) => !open);
              }}
              className={cn(
                "inline-flex h-8 min-h-8 items-center gap-2 rounded-md font-sans text-[11px] transition-colors",
                plainComposerToolbarChrome
                  ? cn(
                      "border border-transparent bg-transparent px-2",
                      selectedTone.activeText,
                      nativeControlsDisabled ? "cursor-not-allowed opacity-50" : selectedTone.hoverBg,
                    )
                  : cn(
                      "border px-2.5 py-1.5",
                      selectedTone.activeBorder,
                      selectedTone.activeBg,
                      selectedTone.activeText,
                      nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "hover:brightness-110",
                    ),
              )}
              title={selectedOption.detail}
            >
              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", selectedTone.dot)} aria-hidden />
              <span className="font-sans text-[11px] leading-none">{selectedOption.label}</span>
              <CaretDown size={10} weight="bold" className="opacity-70" />
            </button>
            {claudeModePickerOpen && claudeModePickerRef.current ? createPortal(
              (() => {
                const rect = claudeModePickerRef.current.getBoundingClientRect();
                return (
                  <div
                    role="listbox"
                    aria-label="Claude permission mode"
                    data-claude-mode-picker-dropdown
                    className="fixed z-[80] w-56 overflow-hidden rounded-lg border border-white/[0.08] bg-[#15151c] shadow-lg shadow-black/40"
                    style={{
                      left: rect.left,
                      bottom: window.innerHeight - rect.top + 8,
                    }}
                  >
                    <div className="border-b border-white/[0.05] px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-fg/50">
                      Mode
                    </div>
                    <ul className="py-1">
                      {CLAUDE_MODE_OPTIONS.map((option) => {
                        const tone = CLAUDE_MODE_TONE_STYLES[option.tone];
                        const active = option.value === claudeSelectionMode;
                        return (
                          <li key={option.value}>
                            <button
                              type="button"
                              role="option"
                              aria-selected={active}
                              onClick={() => {
                                applyClaudeMode(option.value);
                                setClaudeModePickerOpen(false);
                                setHoveredClaudeMode(null);
                              }}
                              onMouseEnter={() => setHoveredClaudeMode(option.value)}
                              onMouseLeave={() => setHoveredClaudeMode(null)}
                              onFocus={() => setHoveredClaudeMode(option.value)}
                              onBlur={() => setHoveredClaudeMode(null)}
                              className={cn(
                                "flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-[11px] transition-colors",
                                active ? cn(tone.activeBg, tone.activeText) : "text-fg/72",
                                tone.hoverBg,
                              )}
                              title={option.detail}
                            >
                              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", tone.dot)} aria-hidden />
                              <span className="flex-1 truncate leading-none">{option.label}</span>
                              {active ? <Check size={10} weight="bold" className="opacity-80" /> : null}
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
        </div>
      );
    }

    if (sp === "codex") {
      const activePreset = codexPresetOptions.find((option) => option.value === codexPreset);
      const presetLabel = codexPreset === "custom"
        ? "Custom"
        : activePreset?.label ?? "Plan";
      const activeColors = activePreset ? safetyColors(activePreset.safety) : null;
      return (
        <div ref={codexPresetPickerRef} className="relative">
          <button
            type="button"
            aria-haspopup="listbox"
            aria-expanded={codexPresetPickerOpen}
            aria-label="Codex approval preset"
            disabled={nativeControlsDisabled}
            onClick={() => {
              if (nativeControlsDisabled) return;
              setCodexPresetPickerOpen((open) => !open);
            }}
            className={cn(
              "inline-flex h-8 min-h-8 items-center gap-2 rounded-md font-sans text-[11px] transition-colors",
              plainComposerToolbarChrome
                ? cn(
                    "border border-transparent bg-transparent px-2 text-fg/80",
                    nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "hover:bg-white/[0.05] hover:text-fg/88",
                  )
                : cn(
                    "border px-2.5 py-1.5",
                    activeColors ? `${activeColors.activeBg} text-fg/88 border-white/[0.08]` : "bg-white/[0.06] text-fg/80 border-white/[0.08]",
                    nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "hover:brightness-110",
                  ),
            )}
            title={activePreset?.detail ?? codexCustomSummary ?? "Codex approval preset"}
          >
            <span className="font-sans text-[11px] leading-none">{presetLabel}</span>
            <CaretDown size={10} weight="bold" className="opacity-70" />
          </button>
          {codexPresetPickerOpen && codexPresetPickerRef.current ? createPortal(
            (() => {
              const rect = codexPresetPickerRef.current.getBoundingClientRect();
              return (
                <div
                  role="listbox"
                  aria-label="Codex approval preset"
                  data-codex-preset-picker-dropdown
                  className="fixed z-[80] w-56 overflow-hidden rounded-lg border border-white/[0.08] bg-[#15151c] shadow-lg shadow-black/40"
                  style={{
                    left: rect.left,
                    bottom: window.innerHeight - rect.top + 8,
                  }}
                >
                  <div className="border-b border-white/[0.05] px-3 py-1.5 font-mono text-[9px] font-bold uppercase tracking-[0.18em] text-muted-fg/50">
                    Preset
                  </div>
                  <ul className="py-1">
                    {codexPresetOptions.map((option) => {
                      const active = codexPreset === option.value;
                      const colors = safetyColors(option.safety);
                      return (
                        <li key={option.value}>
                          <button
                            type="button"
                            role="option"
                            aria-selected={active}
                            onClick={() => {
                              applyCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">);
                              setCodexPresetPickerOpen(false);
                              setHoveredCodexPreset(null);
                            }}
                            onMouseEnter={() => setHoveredCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                            onMouseLeave={() => setHoveredCodexPreset(null)}
                            onFocus={() => setHoveredCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                            onBlur={() => setHoveredCodexPreset(null)}
                            className={cn(
                              "flex w-full items-center gap-2 px-3 py-1.5 text-left font-sans text-[11px] transition-colors",
                              active ? `${colors.activeBg} text-fg/88` : "text-fg/72 hover:bg-white/[0.04]",
                            )}
                            title={option.detail}
                          >
                            <span className="flex-1 truncate leading-none">{option.label}</span>
                            {active ? <Check size={10} weight="bold" className="opacity-80" /> : null}
                          </button>
                        </li>
                      );
                    })}
                    {codexPreset === "custom" ? (
                      <li>
                        <div
                          className="flex w-full items-center gap-2 px-3 py-1.5 font-sans text-[11px] bg-white/[0.06] text-fg/88"
                          title={codexCustomSummary ?? "Custom Codex approval/sandbox combination"}
                        >
                          <span className="flex-1 truncate leading-none">Custom</span>
                          <Check size={10} weight="bold" className="opacity-80" />
                        </div>
                      </li>
                    ) : null}
                  </ul>
                </div>
              );
            })(),
            document.body,
          ) : null}
        </div>
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
      return (
        <div className="flex flex-wrap items-center gap-2">
          {modeChoices.length ? (
            <label
              className={cn(
                "flex h-8 min-h-8 items-center gap-2 rounded-md px-2",
                plainComposerToolbarChrome
                  ? "border border-transparent bg-transparent"
                  : "border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5",
              )}
            >
              <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">Mode</span>
              <select
                value={modeValue}
                disabled={nativeControlsDisabled || (!onCursorModeChange && !parallelControlSlot)}
                onChange={(event) => {
                  if (parallelControlSlot) parallelControlSlot.onCursorModeChange(event.target.value);
                  else onCursorModeChange?.(event.target.value);
                }}
                className="min-w-0 bg-transparent font-sans text-[11px] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
              >
                {modeChoices.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
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
                    "inline-flex h-8 min-h-8 items-center gap-2 rounded-md px-2 font-sans text-[11px] transition-colors",
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
                  <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-fg/45">
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
                <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">
                  {option.name}
                </span>
                <select
                  value={typeof option.currentValue === "string" ? option.currentValue : ""}
                  disabled={nativeControlsDisabled || (!onCursorConfigChange && !parallelControlSlot)}
                  onChange={(event) => {
                    if (parallelControlSlot) parallelControlSlot.onCursorConfigChange(option.id, event.target.value);
                    else onCursorConfigChange?.(option.id, event.target.value);
                  }}
                  className="min-w-0 bg-transparent font-sans text-[11px] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
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

    const runtimeLabel = sp === "cursor" ? "Mode" : "Permissions";
    return (
      <label
        className={cn(
          "flex h-8 min-h-8 items-center gap-2 rounded-md px-2",
          plainComposerToolbarChrome
            ? "border border-transparent bg-transparent"
            : "border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5",
        )}
      >
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">{runtimeLabel}</span>
        <select
          value={opmUse}
          disabled={nativeControlsDisabled || (!onOpenCodePermissionModeChange && !parallelControlSlot)}
          onChange={(event) => {
            const v = event.target.value as AgentChatOpenCodePermissionMode;
            if (parallelControlSlot) parallelControlSlot.onOpenCodePermissionModeChange(v);
            else onOpenCodePermissionModeChange?.(v);
          }}
          className="min-w-0 bg-transparent font-sans text-[11px] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
        >
          {OPENCODE_PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }, [
    claudeSelectionMode,
    claudePermissionMode,
    claudeModePickerOpen,
    codexPresetPickerOpen,
    applyCodexPreset,
    codexPreset,
    codexPresetOptions,
    codexCustomSummary,
    hoveredClaudeMode,
    hoveredCodexPreset,
    nativeControlsDisabled,
    hideNativeControls,
    onClaudeModeChange,
    onClaudePermissionModeChange,
    onInteractionModeChange,
    onCursorConfigChange,
    onCursorModeChange,
    onOpenCodePermissionModeChange,
    cmsUse,
    sp,
    opmUse,
    parallelControlSlot,
    modelId,
    parallelChatMode,
    parallelConfiguringIndex,
    parallelModelSlots,
  ]);

  const composerToolbarReasoningVisible = useMemo(() => {
    if (parallelChatMode) return false;
    const id = modelId?.trim();
    if (!id) return false;
    return (getModelById(id)?.reasoningTiers?.length ?? 0) > 0;
  }, [parallelChatMode, modelId]);

  const composerToolbarGridMode = useMemo<"flex" | "grid2" | "grid3">(() => {
    if (parallelChatMode) return "flex";
    const hasNative = Boolean(nativeControlPanel);
    const reasoning = composerToolbarReasoningVisible;
    const total = (hasNative ? 1 : 0) + 1 + (reasoning ? 1 : 0);
    if (total <= 1) return "flex";
    if (total === 2) return "grid2";
    return "grid3";
  }, [parallelChatMode, nativeControlPanel, composerToolbarReasoningVisible]);

  const composerGlowColor = useMemo(() => {
    const provider = sessionProvider ?? (modelId ? "anthropic" : null);
    if (!provider) return null;
    if (provider === "anthropic") return "rgba(249, 115, 22, 0.25)";
    if (provider === "openai") return "rgba(255, 255, 255, 0.15)";
    if (provider === "cursor") return "rgba(59, 130, 246, 0.25)";
    if (provider === "opencode") return "rgba(255, 255, 255, 0.12)";
    return null;
  }, [sessionProvider, modelId]);

  /* ── Keyboard handler for textarea ── */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const commandModified = event.metaKey || event.ctrlKey;

    /* Command menu keyboard navigation */
    if (commandMenuTrigger) {
      if (event.key === "Escape") { event.preventDefault(); setCommandMenuTrigger(null); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); commandMenuRef.current?.moveDown(); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); commandMenuRef.current?.moveUp(); return; }
      if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); commandMenuRef.current?.selectCurrent(); return; }
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

  const handlePaste = (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!canAttach) return;
    const collected: File[] = [];
    if (event.clipboardData.files.length) {
      for (const file of Array.from(event.clipboardData.files)) collected.push(file);
    }
    if (!collected.length && event.clipboardData.items?.length) {
      for (const item of Array.from(event.clipboardData.items)) {
        if (item.kind !== "file") continue;
        const file = item.getAsFile();
        if (file) collected.push(file);
      }
    }
    if (!collected.length) return;
    event.preventDefault();
    const dt = new DataTransfer();
    for (const file of collected) dt.items.add(file);
    void addFileAttachments(dt.files);
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!canAttach || !event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragActive(true);
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
    setDragActive(false);
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!canAttach || !event.dataTransfer.files.length) return;
    event.preventDefault();
    setDragActive(false);
    void addFileAttachments(event.dataTransfer.files);
  };

  const handleCommandMenuSelect = useCallback((item: ChatCommandMenuItem) => {
    if (item.type === "file" && commandMenuTrigger) {
      if (!canAttach) {
        setAttachError(attachBlockedReason ?? "Attachments are unavailable right now.");
        setCommandMenuTrigger(null);
        return;
      }
      // Replace the @query with @filepath
      const before = draft.slice(0, commandMenuTrigger.cursorIndex);
      const after = draft.slice(commandMenuTrigger.cursorIndex + commandMenuTrigger.query.length + 1); // +1 for @
      onDraftChange(`${before}@${item.path} ${after}`);
      onAddAttachment({ path: item.path, type: inferAttachmentType(item.path) });
    } else if (item.type === "command") {
      const selected = effectiveSlashCommands.find((cmd) => cmd.command.replace(/^\//, "") === item.name);
      if (selected) {
        handleSlashSelect(selected);
      } else {
        onDraftChange(`/${item.name} `);
      }
    }
    setCommandMenuTrigger(null);
  }, [attachBlockedReason, canAttach, commandMenuTrigger, draft, effectiveSlashCommands, handleSlashSelect, onDraftChange, onAddAttachment]);

  const submitComposerDraft = useCallback(() => {
    const isQuestionPending = pendingInput && (pendingInput.kind === "question" || pendingInput.kind === "structured_question");
    if (isQuestionPending) {
      const answer = draft.trim();
      if (!answer.length && !pendingInput.canProceedWithoutAnswer) return;
      onApproval("accept", answer || null);
      onDraftChange("");
      return;
    }
    if (parallelChatMode) {
      if (busy || parallelLaunchBusy) return;
      if (parallelModelSlots.length < 2) return;
      const hasPrompt = draft.trim().length > 0;
      const hasAttachments = attachments.length > 0;
      if (!hasPrompt && !hasAttachments) return;
      onSubmit();
      return;
    }
    if (busy || !modelId || !draft.trim().length) return;
    onSubmit();
  }, [attachments, busy, draft, modelId, onApproval, onDraftChange, onSubmit, pendingInput, parallelChatMode, parallelLaunchBusy, parallelModelSlots.length]);

  const pendingQuestionCount = getPendingInputQuestionCount(pendingInput);
  const showPendingInputOptionsHint = hasPendingInputOptions(pendingInput);

  const composerBeamActive = layoutVariant !== "grid-tile" && (turnActive || !chatHasMessages);
  const composerBeamVariant = turnActive ? "ocean" : "colorful";
  const composerBeamDuration = turnActive ? 20 : 5;
  const composerBeamStrength = turnActive ? 0.26 : 0.44;

  const parallelReady =
    parallelChatMode
    && parallelModelSlots.length >= 2
    && (draft.trim().length > 0 || attachments.length > 0);
  const singleReady = !parallelChatMode && Boolean(modelId) && draft.trim().length > 0;
  const sendEnabled = !busy && !parallelLaunchBusy && (parallelReady || singleReady);

  function sendButtonTitle(): string {
    if (parallelChatMode) {
      if (parallelModelSlots.length < 2) return "Add at least two models";
      if (draft.trim().length === 0 && attachments.length === 0) return "Add a message or at least one attachment";
      return "Send to all lanes";
    }
    if (!modelId) return "Select a model first";
    return "Send";
  }

  return (
    <>
      <BorderBeam
        size="md"
        colorVariant={composerBeamVariant}
        duration={composerBeamDuration}
        strength={composerBeamStrength}
        active={composerBeamActive}
        borderRadius={18}
        className={cn(
          "m-3 mt-0 rounded-[var(--chat-radius-shell)]",
          layoutVariant === "grid-tile" ? "m-0" : "",
        )}
        style={{ overflow: "visible" }}
      >
      <ChatComposerShell
      mode={surfaceMode}
      glowColor={composerGlowColor}
      className={cn(
        layoutVariant === "grid-tile" ? "border-0 bg-transparent shadow-none" : "",
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
        ) : (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-amber-400/20 bg-amber-500/10">
                <ChatStatusGlyph status="waiting" size={11} />
              </span>
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-amber-200">
                {pendingInput.kind === "approval" || pendingInput.kind === "permissions"
                  ? "Approval"
                  : pendingQuestionCount > 1
                    ? `${pendingQuestionCount} Questions`
                    : "Input needed"} · {pendingInput.source}
              </span>
            </div>
            {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? (
              <>
                <div className="mb-2 font-mono text-[11px] leading-relaxed text-fg/68">
                  {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent is waiting for input."}
                </div>
                <div className="flex items-center gap-1.5">
                  <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-accent/30 bg-accent/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept")}>{approvalResponding ? "Processing..." : "Accept"}</button>
                  <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept_for_session")}>Accept all</button>
                  <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("decline")}>Decline</button>
                </div>
              </>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200/60">
                  {showPendingInputOptionsHint
                    ? "Answer in the inline question card, or pick an option there."
                    : "Answer in the inline question card, or type below."}
                </span>
                <button
                  type="button"
                  disabled={approvalResponding}
                  className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none"
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
        attachments.length || attachError ? (
          <div className="space-y-2 px-1 py-2">
            {attachError ? (
              <div className="flex items-center gap-1.5 px-3">
                <span className="text-[10px] text-red-300/75">{attachError}</span>
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
            <ChatAttachmentTray
              attachments={attachments}
              mode={surfaceMode}
              onRemove={onRemoveAttachment}
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
                  className="h-5 flex-1 bg-transparent font-sans text-[11px] text-fg/80 outline-none placeholder:text-muted-fg/25"
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
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/25">Type to search files...</div>
                ) : attachmentBusy ? (
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/25">Searching...</div>
                ) : attachmentResults.length ? (
                  attachmentResults.map((result, index) => (
                    <button
                      key={result.path}
                      type="button"
                      data-active={index === attachmentCursor}
                      className={cn(
                        "ade-chat-drawer-row mx-1 flex w-[calc(100%-0.5rem)] items-center gap-2 rounded-lg px-3 py-2.5 text-left font-mono text-[10px]",
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
                  <div className="px-3 py-2 font-mono text-[10px] text-muted-fg/25">No matching files.</div>
                )}
              </div>
            </div>
          ) : null}
        </>
      }
      footer={
        <div className="flex flex-col gap-2 px-2 py-1.5 sm:px-3 sm:py-2">
          {parallelChatMode ? (
            <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_06%,transparent)] p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-sans text-[12px] font-semibold text-fg/88">Parallel launch</div>
                  <p className="mt-1 font-sans text-[11px] leading-relaxed text-muted-fg/55">
                    Configure each model, then send once. Attachments go to every lane (max {PARALLEL_CHAT_MAX_ATTACHMENTS}).
                  </p>
                </div>
                <SmartTooltip content={{ label: "Single model", description: "Turn off parallel launch and return this draft to one chat session." }}>
                  <button
                    type="button"
                    disabled={parallelLaunchBusy}
                    className="shrink-0 rounded-lg border border-white/[0.1] px-2 py-1 font-sans text-[10px] font-medium text-muted-fg/70 transition-colors hover:bg-white/[0.06] hover:text-fg/80 disabled:opacity-40"
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
                      <span className="flex h-6 min-w-[1.5rem] items-center justify-center rounded-md bg-white/[0.06] font-mono text-[10px] font-bold text-muted-fg/50">
                        {idx + 1}
                      </span>
                      <span className="min-w-0 max-w-[min(200px,46%)] truncate font-sans text-[12px] font-medium text-fg/82">
                        {(desc?.displayName ?? slotRow.modelId) || "Pick a model"}
                      </span>
                      <SmartTooltip content={{ label: configuring ? "Stop configuring" : "Configure model", description: "Edit the model, reasoning, permissions, and launch mode for this parallel lane." }}>
                        <button
                          type="button"
                          className={cn(
                            "rounded-md px-2 py-1 font-sans text-[10px] font-medium transition-colors",
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
                              className="inline-flex items-center gap-1 rounded-md px-2 py-1 font-sans text-[10px] text-red-400/75 transition-colors hover:bg-red-500/10"
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
                  className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/[0.12] px-2.5 py-1.5 font-sans text-[11px] font-medium text-muted-fg/65 transition-colors hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-fg/75 disabled:opacity-40"
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
                  <span className="font-sans text-[11px] text-fg/70">{parallelLaunchStatus}</span>
                </div>
              ) : null}
            </div>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
          {/* Left: permission + model controls */}
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            {(() => {
              const showNativeControls =
                !parallelChatMode
                || (parallelConfiguringIndex != null && parallelModelSlots[parallelConfiguringIndex]);
              if (!showNativeControls || !nativeControlPanel) return null;
              const wrapForUniformHeight = !parallelChatMode && composerToolbarGridMode !== "flex";
              if (!wrapForUniformHeight) return nativeControlPanel;
              return (
                <div
                  className={cn(
                    "min-w-0 flex min-h-8 items-stretch",
                    "[&_button]:h-8 [&_button]:max-h-8 [&_button]:min-h-8 [&_button]:shrink-0 [&_button]:py-0",
                    "[&_label]:flex [&_label]:h-8 [&_label]:max-h-8 [&_label]:min-h-8 [&_label]:items-center [&_label]:py-0",
                    "[&_select]:h-8 [&_select]:max-h-8 [&_select]:min-h-8",
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
                          "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
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
              <ProviderModelSelector
                value={parallelModelSlots[parallelConfiguringIndex]!.modelId}
                onChange={(next) => onParallelSlotModelChange?.(parallelConfiguringIndex, next)}
                availableModelIds={availableModelIds}
                disabled={parallelLaunchBusy}
                showReasoning
                reasoningEffort={parallelModelSlots[parallelConfiguringIndex]!.reasoningEffort}
                onReasoningEffortChange={(effort) => onParallelSlotReasoningChange?.(parallelConfiguringIndex, effort)}
                onOpenAiSettings={onOpenAiSettings}
                compactToolbar
              />
            ) : !parallelChatMode ? (
              <ProviderModelSelector
                value={modelId}
                onChange={onModelChange}
                availableModelIds={availableModelIds}
                disabled={modelSelectionLocked}
                showReasoning
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
                onOpenAiSettings={onOpenAiSettings}
                compactToolbar
              />
            ) : null}
          </div>


          {/* Right: attachment, commands, proof, context, send */}
          <div className="ml-auto flex max-w-full shrink-0 items-center gap-0.5 sm:gap-1">
            <SmartTooltip
              content={{
                label: "Attach from project",
                description: parallelChatMode
                  ? attachBlockedReason ?? "Search the project for files to send to every parallel lane."
                  : "Search the project for files or images to attach to this message.",
                shortcut: "@",
              }}
            >
              <button
                type="button"
                className="inline-flex h-8 min-w-8 max-w-full items-center justify-center rounded-lg px-1.5 font-sans text-[11px] font-medium text-muted-fg/35 transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60"
                disabled={!canAttach}
                onClick={() => canAttach && setAttachmentPickerOpen((o) => !o)}
                aria-label="Open attachment picker"
              >
                @
              </button>
            </SmartTooltip>
            <SmartTooltip
              content={{
                label: "Upload file",
                description: parallelChatMode
                  ? attachBlockedReason ?? "Upload files from disk and send them to every parallel lane."
                  : "Upload a file from disk and attach it to this message.",
              }}
            >
              <button
                type="button"
                className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-fg/35 transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60"
                disabled={!canAttach}
                onClick={openUploadPicker}
                aria-label="Upload file from disk"
              >
                <Paperclip className="h-3 w-3" size={14} weight="bold" />
              </button>
            </SmartTooltip>
            <SmartTooltip content={{ label: "Commands", description: "Open the slash-command picker for this chat.", shortcut: "/" }}>
              <button
                type="button"
                className="inline-flex h-8 min-w-8 items-center justify-center rounded-lg px-1.5 font-sans text-[11px] font-medium text-muted-fg/35 transition-colors hover:bg-violet-500/[0.06] hover:text-violet-300/60"
                onClick={() => {
                  const el = textareaRef.current;
                  const currentDraft = el?.value ?? "";
                  if (!currentDraft.length) onDraftChange("/");
                  const rect = el?.getBoundingClientRect();
                  setCommandMenuTrigger({
                    type: "slash",
                    query: currentDraft.startsWith("/") ? currentDraft.slice(1).match(/^[^\s/]*/)?.[0] ?? "" : "",
                    cursorIndex: 0,
                  });
                  if (rect) setCommandMenuAnchor({ top: rect.top - 8, left: rect.left + 16 });
                  el?.focus();
                }}
                aria-label="Open command picker"
              >
                /
              </button>
            </SmartTooltip>

            {showParallelChatToggle && !parallelChatMode ? (
              <SmartTooltip
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
                    "inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[10px] font-medium transition-colors",
                    "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] hover:text-fg/60",
                    turnActive || busy ? "cursor-not-allowed opacity-40" : "",
                  )}
                  aria-label="Configure parallel models"
                >
                  <SquareSplitHorizontal className="h-3 w-3" size={14} weight="regular" />
                </button>
              </SmartTooltip>
            ) : null}

            {/* Proof drawer toggle */}
            {onToggleProof ? (
              <SmartTooltip
                content={{
                  label: proofOpen ? "Close proof drawer" : "Open proof drawer",
                  description: proofOpen
                    ? "Hide captured screenshots, videos, browser traces, and proof artifacts."
                    : "Show captured screenshots, videos, browser traces, and proof artifacts for this chat.",
                  effect: proofArtifactCount > 0 ? `${proofArtifactCount} artifact${proofArtifactCount === 1 ? "" : "s"} available.` : undefined,
                }}
              >
                <button
                  type="button"
                  className={cn(
                    "relative inline-flex h-8 min-w-8 items-center justify-center gap-1 rounded-lg border px-1.5 font-sans text-[10px] font-medium transition-colors",
                    proofOpen
                      ? "border-emerald-400/22 bg-emerald-500/10 text-emerald-200/80"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-white/[0.10] hover:text-fg/60",
                  )}
                  onClick={onToggleProof}
                  aria-label={proofOpen ? "Close proof drawer" : "Open proof drawer"}
                  aria-pressed={proofOpen}
                >
                  <Cube className="h-3 w-3" size={14} weight={proofOpen ? "fill" : "regular"} />
                  {proofArtifactCount > 0 ? (
                    <span className="inline-flex h-3 min-w-3 items-center justify-center rounded-full bg-emerald-500/20 px-0.5 font-mono text-[8px] font-bold text-emerald-200/90">
                      {proofArtifactCount}
                    </span>
                  ) : null}
                </button>
              </SmartTooltip>
            ) : null}

            {turnActive ? (
              <>
                {draft.trim().length > 0 && onClearDraft ? (
                  <SmartTooltip content={{ label: "Clear draft", description: "Clear the unsent text without interrupting the active turn." }}>
                    <button
                      type="button"
                      className="inline-flex h-6 items-center justify-center rounded-md border border-white/[0.06] px-1.5 font-sans text-[10px] text-muted-fg/45 transition-all hover:bg-white/[0.04] hover:text-fg/72"
                      onClick={onClearDraft}
                    >
                      Clear
                    </button>
                  </SmartTooltip>
                ) : null}
                {draft.trim().length > 0 ? (
                  <SmartTooltip content={{ label: "Send steer message", description: "Queue this message for the running chat after the current turn finishes." }}>
                    <button
                      type="button"
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] transition-all hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
                      onClick={submitComposerDraft}
                      aria-label="Send steer message"
                    >
                      <PaperPlaneTilt size={10} weight="fill" />
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
              <SmartTooltip
                content={{
                  label: parallelChatMode ? "Send to lanes" : "Send message",
                  description: parallelChatMode
                    ? "Create child lanes and send this prompt with its attachments to every configured model."
                    : "Send this prompt to the selected model.",
                  effect: sendButtonTitle(),
                }}
              >
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-8 min-h-0 items-center justify-center rounded-lg border px-2.5 transition-all",
                    sendEnabled
                      ? "border-violet-400/30 bg-gradient-to-r from-violet-600/30 to-violet-500/20 text-white shadow-[0_0_16px_rgba(167,139,250,0.15),0_2px_8px_rgba(124,58,237,0.20)] hover:from-violet-600/40 hover:to-violet-500/30 hover:shadow-[0_0_24px_rgba(167,139,250,0.22),0_4px_12px_rgba(124,58,237,0.25)] active:scale-[0.97]"
                      : "border-white/[0.04] bg-white/[0.02] text-muted-fg/15",
                  )}
                  disabled={!sendEnabled}
                  onClick={submitComposerDraft}
                  aria-label={parallelChatMode ? "Send to parallel lanes" : "Send message"}
                >
                  <PaperPlaneTilt className="h-3 w-3" size={12} weight="fill" />
                  <span className="ml-1 max-w-[8.5rem] truncate font-sans text-[10px] sm:max-w-[11rem]">
                    {parallelChatMode ? "Send to lanes" : "Send"}
                  </span>
                </button>
              </SmartTooltip>
            )}
          </div>
          </div>
        </div>
      }
    >
      {/* Pending steers queue — shows queued messages above the input */}
      {pendingSteers.length > 0 ? (
        <div className="border-b border-white/[0.06] bg-white/[0.02] px-3 py-2 space-y-1.5">
          <div className="flex items-baseline gap-2">
            <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg/30">
              Staged {pendingSteers.length === 1 ? "message" : `messages (${pendingSteers.length})`}
            </span>
            <span className="font-sans text-[9px] text-fg/30">
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
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--chat-accent)]">
                Drop files to attach
              </div>
              <div className="mt-1 text-[12px] text-fg/74">
                {parallelChatMode
                  ? `Up to ${PARALLEL_CHAT_MAX_ATTACHMENTS} files, sent to every parallel lane.`
                  : "Images and files will be added to this turn."}
              </div>
            </div>
          </div>
        ) : null}

        <div className="relative">
          {/* Ghost suggestion overlay */}
          {promptSuggestion && !draft.length && !turnActive ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-start px-4 py-2.5"
              aria-hidden="true"
            >
              <span className="text-[13px] leading-[1.6] text-fg/18 italic">
                {promptSuggestion}
                <span className="ml-2 inline-flex items-center rounded border border-white/[0.06] bg-white/[0.03] px-1 py-px font-mono text-[9px] not-italic text-fg/20">
                  Tab
                </span>
              </span>
            </div>
          ) : null}
          <ChatCommandMenu
            ref={commandMenuRef}
            trigger={commandMenuTrigger}
            slashCommands={effectiveSlashCommands.map((c) => ({
              name: c.command.replace(/^\//, ""),
              description: c.description,
              argumentHint: c.argumentHint,
              source: c.source,
            }))}
            sessionId={sessionId ?? null}
            anchor={commandMenuAnchor}
            onSelect={handleCommandMenuSelect}
            onClose={() => setCommandMenuTrigger(null)}
          />
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const val = event.target.value;
              onDraftChange(val);
              const rect = event.target.getBoundingClientRect();

              if (val.startsWith("/") && !val.slice(1).includes("\n")) {
                // Once the user types a space after the command name they have
                // entered the arguments section — keep the menu only while
                // they're still typing the command name itself, so Enter/Tab
                // submits the slash command instead of being stolen by the menu.
                const afterSlash = val.slice(1);
                if (!/\s/.test(afterSlash)) {
                  const query = afterSlash.match(/^[^\s/]*/)?.[0] ?? "";
                  setCommandMenuTrigger({ type: "slash", query, cursorIndex: 0 });
                  setCommandMenuAnchor({ top: rect.top - 8, left: rect.left + 16 });
                  return;
                }
                setCommandMenuTrigger(null);
                return;
              }

              // Detect @mention trigger
              const cursorPos = event.target.selectionStart ?? val.length;
              const textBeforeCursor = val.slice(0, cursorPos);
              const atMatch = textBeforeCursor.match(/@([^\s@]*)$/);
              if (atMatch) {
                setCommandMenuTrigger({ type: "at", query: atMatch[1], cursorIndex: cursorPos - atMatch[0].length });
                setCommandMenuAnchor({ top: rect.top - 8, left: rect.left + 16 });
              } else {
                setCommandMenuTrigger(null);
              }
            }}
            rows={1}
            onInput={resizeTextarea}
            disabled={parallelLaunchBusy}
            autoComplete="on"
            autoCorrect="on"
            autoCapitalize="sentences"
            spellCheck={true}
            className={cn(
              "block w-full resize-none bg-transparent px-4 py-2.5 text-[13px] leading-[1.6] text-fg/88 outline-none transition-colors placeholder:text-muted-fg/30",
              dragActive ? "opacity-30" : "",
              parallelLaunchBusy ? "cursor-not-allowed opacity-50" : "",
            )}
            data-chat-layout-variant={layoutVariant}
            placeholder={turnActive ? "Steer the active turn..." : (promptSuggestion ? "" : (messagePlaceholder ?? "Type to vibecode..."))}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </div>
      </div>
      </ChatComposerShell>
      </BorderBeam>
    </>
  );
}
