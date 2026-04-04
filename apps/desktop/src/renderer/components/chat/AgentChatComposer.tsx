import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { At, Check, Image, Paperclip, PencilSimple, Square, X, PaperPlaneTilt, Cube, BookOpen, SquareSplitHorizontal, Plus, Trash } from "@phosphor-icons/react";
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
  type AgentChatSlashCommand,
  type AgentChatUnifiedPermissionMode,
  type ComputerUseOwnerSnapshot,
  type ChatSurfaceMode,
  type ComputerUsePolicy,
  type PendingInputRequest,
} from "../../../shared/types";
import { getModelById } from "../../../shared/modelRegistry";
import { cn } from "../ui/cn";
import { UnifiedModelSelector } from "../shared/UnifiedModelSelector";
import { getPermissionOptions, safetyColors } from "../shared/permissionOptions";
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { ChatComposerShell } from "./ChatComposerShell";
import { getPendingInputQuestionCount, hasPendingInputOptions } from "./pendingInput";
import { CURSOR_MODE_LABELS } from "../../../shared/cursorModes";
import { ChatStatusGlyph } from "./chatStatusVisuals";
import { ChatSubagentStrip } from "./ChatSubagentStrip";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

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
  unifiedPermissionMode: AgentChatUnifiedPermissionMode;
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
  onUnifiedPermissionModeChange: (mode: AgentChatUnifiedPermissionMode) => void;
  onCursorModeChange: (modeId: string) => void;
  onCursorConfigChange: (configId: string, value: string | boolean) => void;
};

/** Local-only commands that are always available regardless of provider. */
const LOCAL_SLASH_COMMANDS: SlashCommandEntry[] = [
  { command: "/clear", label: "Clear", description: "Clear chat history", source: "local" },
];

/** Well-known defaults shown before the SDK session is initialized. */
const CLAUDE_DEFAULT_COMMANDS: SlashCommandEntry[] = [];

const CODEX_DEFAULT_COMMANDS: SlashCommandEntry[] = [
  { command: "/review", label: "Review", description: "Review uncommitted changes", source: "sdk" },
  { command: "/help", label: "Help", description: "Show available commands", source: "sdk" },
];

const DEFAULT_COMMANDS_BY_FAMILY: Record<string, SlashCommandEntry[]> = {
  anthropic: CLAUDE_DEFAULT_COMMANDS,
  openai: CODEX_DEFAULT_COMMANDS,
};

/** Build the effective slash command list by merging SDK-provided commands with local ones. */
function buildSlashCommands(sdkCommands: AgentChatSlashCommand[], modelFamily?: string): SlashCommandEntry[] {
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

  // If no SDK commands loaded yet, show well-known defaults for the provider
  if (sdkCommands.length === 0) {
    const defaults = (modelFamily ? DEFAULT_COMMANDS_BY_FAMILY[modelFamily] : undefined) ?? [];
    for (const cmd of defaults) {
      if (!seen.has(cmd.command)) {
        seen.add(cmd.command);
        result.push(cmd);
      }
    }
  }

  // Local commands that aren't already provided by SDK
  for (const cmd of LOCAL_SLASH_COMMANDS) {
    if (!seen.has(cmd.command)) {
      result.push(cmd);
    }
  }

  return result;
}

const CLAUDE_MODE_OPTIONS: Array<{ value: AgentChatClaudePermissionMode; label: string; detail: string; safety: "safe" | "semi-auto" | "danger" }> = [
  { value: "default", label: "Default", detail: "Claude uses the normal approval flow for reads, edits, and tools.", safety: "safe" },
  { value: "plan", label: "Plan", detail: "Read-only Claude turns for analysis and implementation planning.", safety: "safe" },
  { value: "acceptEdits", label: "Accept edits", detail: "File edits are auto-approved; higher-risk actions still prompt.", safety: "semi-auto" },
  { value: "bypassPermissions", label: "Bypass", detail: "Skip Claude permission prompts for this chat.", safety: "danger" },
];

type CodexPermissionPreset = "plan" | "edit" | "full-auto" | "custom";

function resolveCodexPermissionPreset(args: {
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
}): CodexPermissionPreset {
  if (args.codexConfigSource === "config-toml") return "custom";
  if (args.codexApprovalPolicy === "untrusted" && args.codexSandbox === "read-only") return "plan";
  if (args.codexApprovalPolicy === "on-failure" && args.codexSandbox === "workspace-write") return "edit";
  if (args.codexApprovalPolicy === "never" && args.codexSandbox === "danger-full-access") return "full-auto";
  return "custom";
}

const UNIFIED_PERMISSION_OPTIONS: Array<{ value: AgentChatUnifiedPermissionMode; label: string }> = [
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
}: {
  steer: { steerId: string; text: string };
  onCancel: () => void;
  onEdit: (text: string) => void;
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
        <span className="flex-1 min-w-0 truncate text-[12px] leading-[1.5] text-fg/62">
          {steer.text}
        </span>
      )}
      {!editing ? (
        <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/30 hover:bg-white/[0.06] hover:text-fg/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--chat-accent)]/40"
            title="Edit message"
            aria-label="Edit message"
          >
            <PencilSimple size={11} />
          </button>
          <button
            type="button"
            onClick={onCancel}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-fg/30 hover:bg-red-500/10 hover:text-red-400/70 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--chat-accent)]/40"
            title="Remove from queue"
            aria-label="Remove from queue"
          >
            <X size={11} weight="bold" />
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function AgentChatComposer({
  surfaceMode = "standard",
  layoutVariant = "standard",
  composerMaxHeightPx = null,
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
  unifiedPermissionMode,
  cursorModeSnapshot,
  executionMode,
  computerUsePolicy,
  computerUseSnapshot,
  proofOpen = false,
  proofArtifactCount = 0,
  executionModeOptions = [],
  modelSelectionLocked = false,
  permissionModeLocked = false,
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
  onUnifiedPermissionModeChange,
  onCursorModeChange,
  onCursorConfigChange,
  includeProjectDocs,
  onIncludeProjectDocsChange,
  onComputerUsePolicyChange,
  onToggleProof,
  onClearEvents,
  promptSuggestion,
  subagentSnapshots = [],
  chatHasMessages = false,
  restrictModelCatalogToAvailable = false,
  pendingSteers = [],
  onCancelSteer,
  onEditSteer,
  onOpenAiSettings,
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
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
  cursorModeSnapshot?: AgentChatCursorModeSnapshot | null;
  executionMode?: AgentChatExecutionMode | null;
  computerUsePolicy: ComputerUsePolicy;
  computerUseSnapshot?: ComputerUseOwnerSnapshot | null;
  proofOpen?: boolean;
  proofArtifactCount?: number;
  executionModeOptions?: ExecutionModeOption[];
  modelSelectionLocked?: boolean;
  permissionModeLocked?: boolean;
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
  onUnifiedPermissionModeChange?: (mode: AgentChatUnifiedPermissionMode) => void;
  onCursorModeChange?: (modeId: string) => void;
  onCursorConfigChange?: (configId: string, value: string | boolean) => void;
  includeProjectDocs?: boolean;
  onIncludeProjectDocsChange?: (checked: boolean) => void;
  onComputerUsePolicyChange: (policy: ComputerUsePolicy) => void;
  onToggleProof?: () => void;
  onClearEvents?: () => void;
  promptSuggestion?: string | null;
  subagentSnapshots?: ChatSubagentSnapshot[];
  chatHasMessages?: boolean;
  restrictModelCatalogToAvailable?: boolean;
  pendingSteers?: Array<{ steerId: string; text: string }>;
  onCancelSteer?: (steerId: string) => void;
  onEditSteer?: (steerId: string, text: string) => void;
  onOpenAiSettings?: () => void;
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

  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashCursor, setSlashCursor] = useState(0);
  const [hoveredClaudeMode, setHoveredClaudeMode] = useState<AgentChatClaudePermissionMode | null>(null);
  const [hoveredCodexPreset, setHoveredCodexPreset] = useState<"plan" | "edit" | "full-auto" | null>(null);

  const [dragActive, setDragActive] = useState(false);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileAddInProgressRef = useRef(false);
  const canAttach = !turnActive && (!parallelChatMode || attachments.length < PARALLEL_CHAT_MAX_ATTACHMENTS);
  const attachBlockedReason = parallelChatMode && attachments.length >= PARALLEL_CHAT_MAX_ATTACHMENTS
    ? `Maximum ${PARALLEL_CHAT_MAX_ATTACHMENTS} attachments for parallel launch`
    : null;

  const attachedPaths = useMemo(() => new Set(attachments.map((a) => a.path)), [attachments]);
  const selectedModel = useMemo(() => getModelById(modelId), [modelId]);

  const effectiveSlashCommands = useMemo(
    () => buildSlashCommands(sdkSlashCommands, selectedModel?.family),
    [sdkSlashCommands, selectedModel?.family],
  );

  const filteredSlashCommands = useMemo(() => {
    if (!slashQuery.length) return effectiveSlashCommands;
    const q = slashQuery.toLowerCase();
    return effectiveSlashCommands.filter(
      (cmd) =>
        cmd.command.toLowerCase().includes(q) ||
        cmd.label.toLowerCase().includes(q) ||
        cmd.description.toLowerCase().includes(q)
    );
  }, [slashQuery, effectiveSlashCommands]);

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
    if (!parallelChatMode && !canAttach) return;
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
          const t = inferAttachmentType(filePath, file.type);
          onAddAttachment({ path: filePath, type: t });
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
          const t = inferAttachmentType(tempPath, file.type);
          onAddAttachment({ path: tempPath, type: t });
          addedInBatch += 1;
        } catch {
          setAttachError(`Unable to attach "${file.name || "clipboard"}".`);
        }
      }
    } finally {
      fileAddInProgressRef.current = false;
    }
  };

  const handleSlashSelect = (cmd: SlashCommandEntry) => {
    setSlashPickerOpen(false);
    setSlashQuery("");
    // Local-only commands handled client-side
    if (cmd.command === "/clear" && onClearEvents) { onClearEvents(); onDraftChange(""); return; }
    // SDK and all other commands: set as draft text to be sent to the agent
    const suffix = cmd.argumentHint ? ` ${cmd.argumentHint}` : "";
    onDraftChange(`${cmd.command}${suffix} `);
  };

  const nativeControlsDisabled = permissionModeLocked;
  const slot = parallelControlSlot;
  const sp = slot?.sessionProvider ?? sessionProvider ?? "unified";
  const im = slot?.interactionMode ?? interactionMode ?? "default";
  const cpmUse = slot?.claudePermissionMode ?? claudePermissionMode;
  const capUse = slot?.codexApprovalPolicy ?? codexApprovalPolicy;
  const csUse = slot?.codexSandbox ?? codexSandbox;
  const ccsUse = slot?.codexConfigSource ?? codexConfigSource;
  const upmUse = slot?.unifiedPermissionMode ?? unifiedPermissionMode;
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
      .filter((option) => option.value === "plan" || option.value === "edit" || option.value === "full-auto"),
    [],
  );
  const applyCodexPreset = useCallback((preset: Exclude<CodexPermissionPreset, "custom">) => {
    const next = preset === "plan"
      ? {
          codexApprovalPolicy: "untrusted" as const,
          codexSandbox: "read-only" as const,
          codexConfigSource: "flags" as const,
        }
      : preset === "edit"
        ? {
            codexApprovalPolicy: "on-failure" as const,
            codexSandbox: "workspace-write" as const,
            codexConfigSource: "flags" as const,
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
  const codexCustomSummary = useMemo(() => {
    if (sp !== "codex" || codexPreset !== "custom") return null;
    if (ccsUse === "config-toml") {
      return "Custom Codex mode: config.toml controls approval and sandbox.";
    }
    const approvalLabel = {
      "untrusted": "Plan",
      "on-request": "On request",
      "on-failure": "Guarded edit",
      "never": "Full auto",
    }[capUse ?? "on-request"];
    const sandboxLabel = {
      "read-only": "Read only",
      "workspace-write": "Workspace write",
      "danger-full-access": "Danger full access",
    }[csUse ?? "workspace-write"];
    return `Custom Codex mode: ${ccsUse === "flags" ? "ADE flags" : "config.toml"} · ${approvalLabel} · ${sandboxLabel}`;
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
              <button
                key={option.value}
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
                title={option.detail}
                aria-pressed={active}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </div>
    );

    if (sp === "claude") {
      return (
        <div className="flex flex-wrap items-start gap-2">
          {renderButtonGroup("Claude", claudeSelectionMode, CLAUDE_MODE_OPTIONS, (mode) => {
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
          }, nativeControlsDisabled, setHoveredClaudeMode)}
        </div>
      );
    }

    if (sp === "codex") {
      return (
        <div className="flex flex-wrap items-start gap-2">
          <div className="flex items-center gap-px rounded-md border border-white/[0.06] bg-[#1a1a22] p-0.5">
            {codexPresetOptions.map((option) => {
              const active = codexPreset === option.value;
              const colors = safetyColors(option.safety);
              return (
                <button
                  key={option.value}
                  type="button"
                  className={cn(
                    "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                    active ? `${colors.activeBg} text-fg/80` : "text-muted-fg/35 hover:text-muted-fg/60",
                    nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "",
                  )}
                  disabled={nativeControlsDisabled}
                  onClick={() => applyCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                  onMouseEnter={() => setHoveredCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                  onMouseLeave={() => setHoveredCodexPreset(null)}
                  onFocus={() => setHoveredCodexPreset(option.value as Exclude<CodexPermissionPreset, "custom">)}
                  onBlur={() => setHoveredCodexPreset(null)}
                  title={option.detail}
                  aria-pressed={active}
                >
                  {option.label}
                </button>
              );
            })}
            <div
              className={cn(
                "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider",
                codexPreset === "custom" ? "bg-white/[0.06] text-fg/80" : "text-muted-fg/35",
              )}
              title={codexCustomSummary ?? "Custom Codex approval/sandbox combination"}
            >
              Custom
            </div>
          </div>
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
            <label className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5">
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
                    "inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 font-sans text-[11px] transition-colors",
                    active
                      ? "border-emerald-500/24 bg-emerald-500/[0.10] text-emerald-100/88"
                      : "border-white/[0.06] bg-[#1a1a22] text-fg/72",
                    nativeControlsDisabled ? "cursor-not-allowed opacity-50" : "hover:border-white/[0.1] hover:text-fg/86",
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
                className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5"
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

    const runtimeLabel = sp === "cursor" ? "Cursor" : "ADE";
    return (
      <label className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">{runtimeLabel}</span>
        <select
          value={upmUse}
          disabled={nativeControlsDisabled || (!onUnifiedPermissionModeChange && !parallelControlSlot)}
          onChange={(event) => {
            const v = event.target.value as AgentChatUnifiedPermissionMode;
            if (parallelControlSlot) parallelControlSlot.onUnifiedPermissionModeChange(v);
            else onUnifiedPermissionModeChange?.(v);
          }}
          className="min-w-0 bg-transparent font-sans text-[11px] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
        >
          {UNIFIED_PERMISSION_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );
  }, [
    claudeSelectionMode,
    applyCodexPreset,
    codexPreset,
    codexPresetOptions,
    codexCustomSummary,
    hoveredClaudeMode,
    hoveredCodexPreset,
    nativeControlsDisabled,
    onClaudeModeChange,
    onClaudePermissionModeChange,
    onInteractionModeChange,
    onCursorConfigChange,
    onCursorModeChange,
    onUnifiedPermissionModeChange,
    cmsUse,
    sp,
    upmUse,
    parallelControlSlot,
  ]);
  /* ── Keyboard handler for textarea ── */
  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    const commandModified = event.metaKey || event.ctrlKey;

    /* Slash picker keyboard */
    if (slashPickerOpen) {
      if (event.key === "Escape") { event.preventDefault(); setSlashPickerOpen(false); setSlashQuery(""); return; }
      if (event.key === "ArrowDown") { event.preventDefault(); setSlashCursor((v) => Math.min(v + 1, Math.max(filteredSlashCommands.length - 1, 0))); return; }
      if (event.key === "ArrowUp") { event.preventDefault(); setSlashCursor((v) => Math.max(v - 1, 0)); return; }
      if (event.key === "Enter" || event.key === "Tab") {
        const cmd = filteredSlashCommands[slashCursor];
        if (cmd) { event.preventDefault(); handleSlashSelect(cmd); return; }
      }
    }

    /* Trigger pickers — let "/" be typed so onChange can filter */
    if (event.key === "/" && draft.length === 0 && !commandModified && !event.altKey) {
      setSlashPickerOpen(true);
      setSlashQuery("");
      setSlashCursor(0);
      // Don't preventDefault — the "/" will appear in the textarea and onChange will
      // see val.startsWith("/"), keeping the picker open and enabling type-to-filter.
    }
    if (event.key === "@" && !commandModified && !event.altKey) {
      if (!canAttach) return;
      event.preventDefault();
      setAttachmentPickerOpen(true);
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
    if (!canAttach || !event.clipboardData.files.length) return;
    event.preventDefault();
    void addFileAttachments(event.clipboardData.files);
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

  return (
    <>
      <ChatComposerShell
      mode={surfaceMode}
      className={cn(
        "m-3 mt-0 rounded-[var(--chat-radius-shell)]",
        layoutVariant === "grid-tile" ? "m-0 rounded-none border-0 bg-transparent shadow-none" : "",
      )}
      pendingBanner={pendingInput ? (
        pendingInput.kind === "plan_approval" ? (
          <div className="px-4 py-3">
            <div className="mb-2 flex items-center gap-2">
              <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-violet-400/20 bg-violet-500/10">
                <ChatStatusGlyph status="waiting" size={11} />
              </span>
              <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-violet-200">
                Plan Approval · {pendingInput.source}
              </span>
            </div>
            <div className="mb-2 max-h-48 overflow-y-auto font-mono text-[11px] leading-relaxed text-fg/68 whitespace-pre-wrap">
              {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent has prepared a plan."}
            </div>
            <div className="flex items-center gap-1.5">
              <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-emerald-400/30 bg-emerald-500/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-emerald-200/80 transition-colors hover:bg-emerald-500/20 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept")}>{approvalResponding ? "Processing..." : "Approve & Implement"}</button>
              <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("decline")}>Reject &amp; Revise</button>
            </div>
          </div>
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
            <div className="mb-2 font-mono text-[11px] leading-relaxed text-fg/68">
              {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent is waiting for input."}
            </div>
            {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? (
              <div className="flex items-center gap-1.5">
                <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-accent/30 bg-accent/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept")}>{approvalResponding ? "Processing..." : "Accept"}</button>
                <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("accept_for_session")}>Accept all</button>
                <button type="button" disabled={approvalResponding} className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10 disabled:opacity-40 disabled:pointer-events-none" onClick={() => onApproval("decline")}>Decline</button>
              </div>
            ) : (
              <div className="flex items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200/60">
                  {showPendingInputOptionsHint ? "Type your answer below or pick an option above." : "Type your answer below."}
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
        attachments.length || subagentSnapshots.length || attachError ? (
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
            {subagentSnapshots.length ? (
              <ChatSubagentStrip
                snapshots={subagentSnapshots}
                placement="composer"
                onInterruptTurn={turnActive ? onInterrupt : undefined}
              />
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
          {slashPickerOpen && filteredSlashCommands.length > 0 ? (
            <div className="absolute bottom-full left-3 z-10 mb-3 w-80 rounded-[var(--chat-radius-card)] border border-white/[0.06] bg-card/95 shadow-[var(--chat-composer-shadow)] backdrop-blur-xl">
              <div className="border-b border-white/[0.04] px-3 py-2 font-mono text-[9px] font-bold uppercase tracking-widest text-muted-fg/35">
                Commands
              </div>
              <div className="max-h-52 overflow-auto py-1">
                {filteredSlashCommands.map((cmd, index) => (
                  <button
                    key={cmd.command}
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-3 px-3 py-2 text-left font-mono text-[10px]",
                      index === slashCursor ? "bg-accent/10 text-fg" : "text-fg/55 hover:bg-border/6",
                    )}
                    onMouseEnter={() => setSlashCursor(index)}
                    onClick={() => handleSlashSelect(cmd)}
                  >
                    <span className="w-16 shrink-0 text-accent/70">{cmd.command}</span>
                    <span className="flex-1 truncate text-fg/45">{cmd.description}</span>
                    {cmd.source === "sdk" ? (
                      <span className="shrink-0 rounded-sm bg-violet-500/10 px-1 py-px text-[8px] text-violet-300/60">sdk</span>
                    ) : null}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          {attachmentPickerOpen ? (
            <div className="absolute bottom-full left-3 z-10 mb-3 w-80 rounded-[var(--chat-radius-card)] border border-white/[0.06] bg-card/95 shadow-[var(--chat-composer-shadow)] backdrop-blur-xl">
              <div className="flex items-center gap-2 border-b border-white/[0.04] px-3 py-2">
                <At size={11} weight="bold" className="text-muted-fg/30" />
                <input
                  ref={attachmentInputRef}
                  value={attachmentQuery}
                  onChange={(e) => setAttachmentQuery(e.target.value)}
                  placeholder="Search files..."
                  className="h-5 flex-1 bg-transparent font-mono text-[11px] text-fg/80 outline-none placeholder:text-muted-fg/25"
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
                      className={cn(
                        "flex w-full items-center gap-2 px-3 py-2 text-left font-mono text-[10px] text-fg/60",
                        index === attachmentCursor ? "bg-accent/10 text-fg/85" : "hover:bg-border/6",
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
        <div className="flex flex-col gap-2 px-3 py-1.5">
          {showParallelChatToggle && !parallelChatMode ? (
            <button
              type="button"
              disabled={turnActive || busy}
              onClick={() => onParallelChatModeChange?.(true)}
              className={cn(
                "flex w-full items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors",
                "border-white/[0.08] bg-white/[0.02] hover:border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_06%,transparent)]",
                turnActive || busy ? "cursor-not-allowed opacity-40" : "",
              )}
            >
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-white/[0.08] bg-white/[0.04] text-[var(--chat-accent)]">
                <SquareSplitHorizontal size={18} weight="regular" />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block font-sans text-[12px] font-medium text-fg/85">Parallel models</span>
                <span className="mt-0.5 block font-sans text-[11px] leading-snug text-muted-fg/55">
                  Same prompt and attachments in one child lane per model
                </span>
              </span>
            </button>
          ) : null}
          {parallelChatMode ? (
            <div className="rounded-xl border border-[color:color-mix(in_srgb,var(--chat-accent)_22%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_06%,transparent)] p-3">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-sans text-[12px] font-semibold text-fg/88">Parallel launch</div>
                  <p className="mt-1 font-sans text-[11px] leading-relaxed text-muted-fg/55">
                    Configure each model, then send once. Attachments go to every lane (max {PARALLEL_CHAT_MAX_ATTACHMENTS}).
                  </p>
                </div>
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
                      {parallelModelSlots.length > 2 ? (
                        <button
                          type="button"
                          className="ml-auto inline-flex items-center gap-1 rounded-md px-2 py-1 font-sans text-[10px] text-red-400/75 transition-colors hover:bg-red-500/10"
                          disabled={parallelLaunchBusy}
                          onClick={() => onParallelRemoveModel?.(idx)}
                          title="Remove this model from the parallel set"
                        >
                          <Trash size={12} />
                          Remove
                        </button>
                      ) : null}
                    </div>
                  );
                })}
              </div>
              <button
                type="button"
                className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-dashed border-white/[0.12] px-2.5 py-1.5 font-sans text-[11px] font-medium text-muted-fg/65 transition-colors hover:border-white/[0.2] hover:bg-white/[0.04] hover:text-fg/75 disabled:opacity-40"
                disabled={parallelLaunchBusy}
                onClick={() => onParallelAddModel?.()}
              >
                <Plus size={14} weight="bold" />
                Add model
              </button>
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
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            {parallelChatMode && parallelConfiguringIndex != null && parallelModelSlots[parallelConfiguringIndex]
              ? nativeControlPanel
              : !parallelChatMode
                ? nativeControlPanel
                : null}
            {parallelChatMode && parallelConfiguringIndex != null && parallelSlotExecutionModeOptions.length > 0 ? (
              <div className="flex flex-wrap items-center gap-px rounded-md border border-white/[0.06] bg-[#1a1a22] p-0.5">
                {parallelSlotExecutionModeOptions.map((option) => {
                  const active = parallelSlotExecutionMode === option.value;
                  return (
                    <button
                      key={option.value}
                      type="button"
                      className={cn(
                        "rounded-[8px] px-2.5 py-1.5 font-mono text-[9px] font-bold uppercase tracking-wider transition-colors",
                        active ? "bg-white/[0.08] text-fg/80" : "text-muted-fg/35 hover:text-muted-fg/60",
                        parallelLaunchBusy ? "cursor-not-allowed opacity-50" : "",
                      )}
                      disabled={parallelLaunchBusy}
                      onClick={() => onParallelSlotExecutionModeChange?.(option.value)}
                      title={option.helper}
                      aria-pressed={active}
                    >
                      {option.label}
                    </button>
                  );
                })}
              </div>
            ) : null}
            {parallelChatMode && parallelConfiguringIndex != null && parallelModelSlots[parallelConfiguringIndex] ? (
              <UnifiedModelSelector
                value={parallelModelSlots[parallelConfiguringIndex]!.modelId}
                onChange={(next) => onParallelSlotModelChange?.(parallelConfiguringIndex, next)}
                availableModelIds={availableModelIds}
                catalogMode={restrictModelCatalogToAvailable ? "available-only" : "all"}
                disabled={parallelLaunchBusy}
                showReasoning
                reasoningEffort={parallelModelSlots[parallelConfiguringIndex]!.reasoningEffort}
                onReasoningEffortChange={(effort) => onParallelSlotReasoningChange?.(parallelConfiguringIndex, effort)}
                onOpenAiSettings={onOpenAiSettings}
              />
            ) : !parallelChatMode ? (
            <UnifiedModelSelector
              value={modelId}
              onChange={onModelChange}
              availableModelIds={availableModelIds}
              catalogMode={restrictModelCatalogToAvailable ? "available-only" : "all"}
              disabled={modelSelectionLocked}
              showReasoning
              reasoningEffort={reasoningEffort}
              onReasoningEffortChange={onReasoningEffortChange}
              onOpenAiSettings={onOpenAiSettings}
            />
            ) : null}
          </div>

          {/* Right: attachment, commands, proof, context, send */}
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <button
              type="button"
              className="rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/30 transition-colors hover:bg-white/5 hover:text-muted-fg/60"
              disabled={!canAttach}
              onClick={() => canAttach && setAttachmentPickerOpen((o) => !o)}
              title={
                parallelChatMode
                  ? attachBlockedReason ?? "Search repo for files (@)"
                  : "Attach files or images (@)"
              }
              aria-label="Open attachment picker"
            >
              @
            </button>
            <button
              type="button"
              className="rounded-md px-1 py-1 text-muted-fg/30 transition-colors hover:bg-white/5 hover:text-muted-fg/60"
              disabled={!canAttach}
              onClick={openUploadPicker}
              title={parallelChatMode ? (attachBlockedReason ?? "Upload files") : "Upload file from disk"}
              aria-label="Upload file from disk"
            >
              <Paperclip size={11} />
            </button>
            <button
              type="button"
              className="rounded-md px-1.5 py-1 font-sans text-[10px] text-muted-fg/30 transition-colors hover:bg-white/5 hover:text-muted-fg/60"
              onClick={() => { const d = textareaRef.current?.value ?? ""; if (!d.length) { onDraftChange("/"); } setSlashPickerOpen(true); setSlashQuery(d.startsWith("/") ? d.slice(1) : ""); setSlashCursor(0); textareaRef.current?.focus(); }}
              title="Commands (/)"
              aria-label="Open command picker"
            >
              /
            </button>

            {/* Proof drawer toggle */}
            {onToggleProof ? (
              <button
                type="button"
                className={cn(
                  "relative inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-sans text-[10px] font-medium transition-colors",
                  proofOpen
                    ? "border-emerald-400/22 bg-emerald-500/10 text-emerald-200/80"
                    : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-white/[0.10] hover:text-fg/60",
                )}
                onClick={onToggleProof}
                title={proofOpen ? "Close proof drawer" : "Open proof drawer"}
                aria-label={proofOpen ? "Close proof drawer" : "Open proof drawer"}
                aria-pressed={proofOpen}
              >
                <Cube size={11} weight={proofOpen ? "fill" : "regular"} />
                {proofArtifactCount > 0 ? (
                  <span className="inline-flex h-[12px] min-w-[12px] items-center justify-center rounded-full bg-emerald-500/20 px-0.5 font-mono text-[8px] font-bold text-emerald-200/90">
                    {proofArtifactCount}
                  </span>
                ) : null}
              </button>
            ) : null}

            {/* Include context toggle */}
            {!chatHasMessages && onIncludeProjectDocsChange ? (
              <button
                type="button"
                className={cn(
                  "inline-flex h-6 items-center gap-1 rounded-md border px-1.5 font-sans text-[10px] font-medium transition-colors",
                  includeProjectDocs
                    ? "border-accent/22 bg-accent/10 text-accent"
                    : "border-white/[0.06] bg-white/[0.02] text-muted-fg/30 hover:border-white/[0.10] hover:text-fg/60",
                )}
                onClick={() => onIncludeProjectDocsChange(!includeProjectDocs)}
                title="Include project context (PRD + architecture) with first message"
                aria-pressed={!!includeProjectDocs}
              >
                <BookOpen size={11} weight={includeProjectDocs ? "fill" : "regular"} />
                <span>Context</span>
              </button>
            ) : null}

            {turnActive ? (
              <>
                {draft.trim().length > 0 && onClearDraft ? (
                  <button
                    type="button"
                    className="inline-flex h-6 items-center justify-center rounded-md border border-white/[0.06] px-1.5 font-sans text-[10px] text-muted-fg/45 transition-all hover:bg-white/[0.04] hover:text-fg/72"
                    onClick={onClearDraft}
                    title="Clear draft only"
                  >
                    Clear
                  </button>
                ) : null}
                {draft.trim().length > 0 ? (
                  <button
                    type="button"
                    className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] transition-all hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
                    onClick={submitComposerDraft}
                    title="Send steer message"
                    aria-label="Send steer message"
                  >
                    <PaperPlaneTilt size={10} weight="fill" />
                  </button>
                ) : null}
                <button
                  type="button"
                  className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-red-500/20 bg-red-500/[0.06] text-red-400/70 transition-all hover:border-red-500/35 hover:bg-red-500/12 hover:text-red-400"
                  title="Stop the active turn only (Cmd+.)"
                  aria-label="Stop active turn"
                  onClick={onInterrupt}
                >
                  <Square size={9} weight="fill" />
                </button>
              </>
            ) : (
              <button
                type="button"
                className={cn(
                  "inline-flex h-6 items-center justify-center rounded-md border px-2.5 transition-all",
                  (() => {
                    const parallelReady =
                      parallelChatMode
                      && parallelModelSlots.length >= 2
                      && (draft.trim().length > 0 || attachments.length > 0);
                    const singleReady = !parallelChatMode && Boolean(modelId) && draft.trim().length > 0;
                    const enabled = !busy && !parallelLaunchBusy && (parallelReady || singleReady);
                    return enabled
                      ? "border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)]"
                      : "border-white/[0.04] text-muted-fg/12";
                  })(),
                )}
                disabled={
                  busy
                  || parallelLaunchBusy
                  || (parallelChatMode
                    ? parallelModelSlots.length < 2 || (draft.trim().length === 0 && attachments.length === 0)
                    : !modelId || !draft.trim().length)
                }
                onClick={submitComposerDraft}
                title={
                  parallelChatMode
                    ? parallelModelSlots.length < 2
                      ? "Add at least two models"
                      : draft.trim().length === 0 && attachments.length === 0
                        ? "Add a message or at least one attachment"
                        : "Send to all lanes"
                    : !modelId
                      ? "Select a model first"
                      : "Send"
                }
              >
                <PaperPlaneTilt size={10} weight="fill" />
                <span className="ml-1 font-sans text-[10px]">
                  {parallelChatMode ? "Send to lanes" : "Send"}
                </span>
              </button>
            )}
          </div>
          </div>
        </div>
      }
    >
      {/* Pending steers queue — shows queued messages above the input */}
      {pendingSteers.length > 0 ? (
        <div className="border-b border-white/[0.06] px-3 py-2 space-y-1.5">
          <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-fg/30">
            Pending {pendingSteers.length === 1 ? "message" : `messages (${pendingSteers.length})`}
          </div>
          {pendingSteers.map((steer) => (
            <PendingSteerItem
              key={steer.steerId}
              steer={steer}
              onCancel={() => onCancelSteer?.(steer.steerId)}
              onEdit={(text) => onEditSteer?.(steer.steerId, text)}
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
          <textarea
            ref={textareaRef}
            value={draft}
            onChange={(event) => {
              const val = event.target.value;
              onDraftChange(val);
              if (slashPickerOpen && !val.startsWith("/")) { setSlashPickerOpen(false); setSlashQuery(""); }
              if (val.startsWith("/")) { setSlashQuery(val.slice(1)); setSlashCursor(0); }
            }}
            disabled={parallelLaunchBusy}
            className={cn(
              "min-h-[44px] w-full bg-transparent px-4 py-2.5 text-[13px] leading-[1.6] text-fg/88 outline-none transition-colors placeholder:text-muted-fg/25",
              layoutVariant === "grid-tile" ? "resize-y" : "max-h-[200px] resize-none",
              dragActive ? "opacity-30" : "",
              parallelLaunchBusy ? "cursor-not-allowed opacity-50" : "",
            )}
            style={layoutVariant === "grid-tile" && composerMaxHeightPx != null
              ? { maxHeight: `${composerMaxHeightPx}px` }
              : undefined}
            data-chat-layout-variant={layoutVariant}
            placeholder={turnActive ? "Steer the active turn..." : (promptSuggestion ? "" : (messagePlaceholder ?? "Type to vibecode..."))}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </div>
      </div>
      </ChatComposerShell>
    </>
  );
}
