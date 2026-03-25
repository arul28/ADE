import { useEffect, useMemo, useRef, useState } from "react";
import { At, CaretDown, Image, Paperclip, Square, X, PaperPlaneTilt, Lightning } from "@phosphor-icons/react";
import {
  inferAttachmentType,
  type AgentChatApprovalDecision,
  type AgentChatClaudePermissionMode,
  type AgentChatCodexApprovalPolicy,
  type AgentChatCodexConfigSource,
  type AgentChatCodexSandbox,
  type AgentChatExecutionMode,
  type AgentChatFileRef,
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
import { ChatAttachmentTray } from "./ChatAttachmentTray";
import { ChatComposerShell } from "./ChatComposerShell";
import { ChatSubagentStrip } from "./ChatSubagentStrip";
import type { ChatSubagentSnapshot } from "./chatExecutionSummary";

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

const CLAUDE_PERMISSION_OPTIONS: Array<{ value: AgentChatClaudePermissionMode; label: string }> = [
  { value: "default", label: "Default" },
  { value: "plan", label: "Plan" },
  { value: "acceptEdits", label: "Accept edits" },
  { value: "bypassPermissions", label: "Bypass" },
];

const CODEX_APPROVAL_OPTIONS: Array<{ value: AgentChatCodexApprovalPolicy; label: string }> = [
  { value: "untrusted", label: "Untrusted" },
  { value: "on-request", label: "On request" },
  { value: "on-failure", label: "On failure" },
  { value: "never", label: "Never" },
];

const CODEX_SANDBOX_OPTIONS: Array<{ value: AgentChatCodexSandbox; label: string }> = [
  { value: "read-only", label: "Read only" },
  { value: "workspace-write", label: "Workspace write" },
  { value: "danger-full-access", label: "Danger full access" },
];

const CODEX_CONFIG_SOURCE_OPTIONS: Array<{ value: AgentChatCodexConfigSource; label: string }> = [
  { value: "flags", label: "ADE flags" },
  { value: "config-toml", label: "config.toml" },
];

const UNIFIED_PERMISSION_OPTIONS: Array<{ value: AgentChatUnifiedPermissionMode; label: string }> = [
  { value: "plan", label: "Plan" },
  { value: "edit", label: "Edit" },
  { value: "full-auto", label: "Full auto" },
];

type AdvancedSettingsPopoverProps = {
  executionModeOptions: ExecutionModeOption[];
  executionMode: AgentChatExecutionMode | null;
  onExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  computerUsePolicy: ComputerUsePolicy;
  computerUseSnapshot: ComputerUseOwnerSnapshot | null;
  onOpenComputerUseDetails: () => void;
  proofOpen: boolean;
  proofArtifactCount: number;
  onToggleProof?: () => void;
  includeProjectDocs?: boolean;
  onIncludeProjectDocsChange?: (checked: boolean) => void;
};

function AdvancedSettingsPopover({
  executionModeOptions,
  executionMode,
  onExecutionModeChange,
  computerUsePolicy,
  computerUseSnapshot,
  onOpenComputerUseDetails,
  proofOpen,
  proofArtifactCount,
  onToggleProof,
  includeProjectDocs,
  onIncludeProjectDocsChange,
}: AdvancedSettingsPopoverProps) {
  const [hoveredExecutionMode, setHoveredExecutionMode] = useState<AgentChatExecutionMode | null>(null);
  const activeBackend = computerUseSnapshot?.activeBackend?.name ?? (computerUsePolicy.allowLocalFallback ? "Fallback allowed" : "No fallback");
  const activeExecutionMode = executionModeOptions.find((option) => option.value === executionMode) ?? executionModeOptions[0] ?? null;
  const helpMode = hoveredExecutionMode
    ? executionModeOptions.find((option) => option.value === hoveredExecutionMode) ?? activeExecutionMode
    : activeExecutionMode;

  return (
    <div className="absolute bottom-full right-0 z-30 mb-3 w-[min(44rem,calc(100vw-2rem))] overflow-hidden rounded-[22px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(18,20,28,0.98),rgba(10,12,18,0.98))] shadow-[0_24px_90px_-40px_rgba(0,0,0,0.88)] backdrop-blur-xl">
      <div className="border-b border-white/[0.05] px-4 py-3">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <div className="font-sans text-[12px] font-semibold tracking-tight text-fg/86">Advanced settings</div>
            <div className="max-w-[34rem] text-[11px] leading-5 text-fg/54">
              Tune execution behavior, computer use, proof retention, and project context without widening the main composer.
            </div>
          </div>
          <button
            type="button"
            className="rounded-[var(--chat-radius-pill)] border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-sans text-[11px] font-medium text-fg/58 transition-colors hover:text-fg/82"
            onClick={onOpenComputerUseDetails}
            title="Open the detailed computer-use settings"
          >
            Computer use details
          </button>
        </div>
      </div>

      <div className="space-y-4 px-4 py-4">
        {executionModeOptions.length > 0 && onExecutionModeChange ? (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="font-sans text-[11px] font-semibold uppercase tracking-[0.16em] text-fg/64">Execution mode</div>
                <div className="mt-1 text-[11px] leading-5 text-fg/48">Choose whether the model stays in one thread or spreads work across delegates.</div>
              </div>
              {helpMode ? (
                <div className="rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1 font-sans text-[10px] font-medium text-fg/72">
                  {helpMode.summary}
                </div>
              ) : null}
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              {executionModeOptions.map((option) => {
                const isActive = executionMode === option.value;
                return (
                  <button
                    key={option.value}
                    type="button"
                    className={cn(
                      "rounded-[18px] border px-3 py-2 text-left transition-colors",
                      isActive
                        ? "border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-fg/84"
                        : "border-white/[0.06] bg-white/[0.03] text-fg/62 hover:border-white/[0.12] hover:bg-white/[0.05]",
                    )}
                    style={isActive ? {
                      borderColor: `${option.accent}44`,
                      background: `${option.accent}16`,
                    } : undefined}
                    onClick={() => onExecutionModeChange(option.value)}
                    onMouseEnter={() => setHoveredExecutionMode(option.value)}
                    onMouseLeave={() => setHoveredExecutionMode(null)}
                    title={option.helper}
                    aria-pressed={isActive}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-sans text-[12px] font-medium text-fg/82">{option.label}</span>
                      <span className="font-sans text-[10px] uppercase tracking-[0.16em] text-fg/34">{option.summary}</span>
                    </div>
                    <div className="mt-1 text-[11px] leading-5 text-fg/54">{option.helper}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-2">
          <button
            type="button"
            className={cn(
              "rounded-[18px] border px-3 py-3 text-left transition-colors",
              proofOpen || proofArtifactCount > 0
                ? "border-emerald-400/22 bg-emerald-500/10"
                : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.12] hover:bg-white/[0.05]",
            )}
            onClick={onToggleProof}
            aria-pressed={proofOpen}
            disabled={!onToggleProof}
            title="Open or hide the proof drawer for retained screenshots, traces, logs, and verification output"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans text-[12px] font-medium text-fg/84">Proof</span>
              <span className={cn(
                "rounded-md border px-2 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-[0.14em]",
                proofOpen
                  ? "border-emerald-400/25 bg-emerald-500/10 text-emerald-200"
                  : "border-white/[0.08] bg-white/[0.03] text-fg/45",
              )}>
                {proofArtifactCount > 0 ? `${proofArtifactCount} artifacts` : proofOpen ? "Open" : "Closed"}
              </span>
            </div>
            <div className="mt-1 text-[11px] leading-5 text-fg/58">
              Inspect retained screenshots, traces, logs, and validation output from this chat.
            </div>
          </button>

          <button
            type="button"
            className={cn(
              "rounded-[18px] border px-3 py-3 text-left transition-colors md:col-span-2",
              includeProjectDocs
                ? "border-accent/22 bg-accent/10"
                : "border-white/[0.06] bg-white/[0.03] hover:border-white/[0.12] hover:bg-white/[0.05]",
            )}
            onClick={() => onIncludeProjectDocsChange?.(!includeProjectDocs)}
            aria-pressed={!!includeProjectDocs}
            disabled={!onIncludeProjectDocsChange}
            title="Include project-level context docs (PRD and architecture) with the first message"
          >
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans text-[12px] font-medium text-fg/84">Project Context</span>
              <span className={cn(
                "rounded-md border px-2 py-0.5 font-sans text-[9px] font-semibold uppercase tracking-[0.14em]",
                includeProjectDocs
                  ? "border-accent/25 bg-accent/10 text-accent"
                  : "border-white/[0.08] bg-white/[0.03] text-fg/45",
              )}>
                {includeProjectDocs ? "Included" : "Off"}
              </span>
            </div>
            <div className="mt-1 text-[11px] leading-5 text-fg/58">
              Attach the project-level PRD and architecture context to the next turn so the agent starts with more background.
            </div>
          </button>
        </div>

        {helpMode ? (
          <div className="rounded-[18px] border border-white/[0.06] bg-black/20 px-3 py-2">
            <div className="flex items-center justify-between gap-2">
              <span className="font-sans text-[10px] font-semibold uppercase tracking-[0.16em] text-fg/48">Mode help</span>
              <span className="font-sans text-[10px] text-fg/38">{helpMode.label}</span>
            </div>
            <div className="mt-1 text-[11px] leading-5 text-fg/58">{hoveredExecutionMode ? helpMode.helper : helpMode.summary}</div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ComputerUseSettingsModal({
  open,
  policy,
  snapshot,
  onClose,
  onChange,
  onOpenProof,
}: {
  open: boolean;
  policy: ComputerUsePolicy;
  snapshot: ComputerUseOwnerSnapshot | null;
  onClose: () => void;
  onChange: (policy: ComputerUsePolicy) => void;
  onOpenProof: () => void;
}) {
  if (!open) return null;

  const activeBackend = snapshot?.activeBackend?.name ?? "None";
  const artifactCount = snapshot?.artifacts.length ?? 0;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-[radial-gradient(circle_at_top,rgba(56,189,248,0.1),rgba(7,10,18,0.88))] px-4 backdrop-blur-md"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="w-full max-w-sm overflow-hidden rounded-[28px] border border-white/[0.08] bg-[linear-gradient(180deg,rgba(15,21,34,0.96),rgba(10,13,22,0.94))] shadow-[0_28px_110px_-36px_rgba(0,0,0,0.82)]">
        <div className="border-b border-white/[0.05] bg-[linear-gradient(90deg,rgba(56,189,248,0.12),transparent)] px-5 py-4">
          <div className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <div className="font-sans text-[15px] font-semibold tracking-tight text-fg/88">Computer use</div>
              <div className="text-[12px] leading-5 text-fg/58">
                ADE captures proof from your agent's tool calls automatically.
              </div>
            </div>
            <button
              type="button"
              className="rounded-[var(--chat-radius-pill)] border border-white/[0.08] bg-white/[0.03] px-3 py-1 font-sans text-[11px] font-medium text-fg/60 transition-colors hover:text-fg/85"
              onClick={onClose}
              title="Close"
            >
              Close
            </button>
          </div>
        </div>

        <div className="space-y-4 px-5 py-5">
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <span className="font-sans text-[11px] uppercase tracking-[0.14em] text-muted-fg/40">Backend</span>
              <span className="text-[12px] text-fg/78">{activeBackend}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="font-sans text-[11px] uppercase tracking-[0.14em] text-muted-fg/40">Artifacts</span>
              <span className="text-[12px] text-fg/78">{artifactCount} captured</span>
            </div>
          </div>

          <div className="grid gap-3">
            <button
              type="button"
              className="rounded-[18px] border border-white/[0.06] bg-white/[0.03] px-4 py-2.5 font-sans text-[12px] font-medium text-fg/78 transition-colors hover:border-white/[0.12] hover:text-fg/90"
              onClick={onOpenProof}
              title="Open the proof drawer"
            >
              Open proof drawer
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AgentChatComposer({
  surfaceMode = "standard",
  sdkSlashCommands = [],
  modelId,
  availableModelIds,
  reasoningEffort,
  draft,
  attachments,
  pendingInput,
  turnActive,
  sendOnEnter,
  busy,
  sessionProvider,
  claudePermissionMode,
  codexApprovalPolicy,
  codexSandbox,
  codexConfigSource,
  unifiedPermissionMode,
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
  onClaudePermissionModeChange,
  onCodexApprovalPolicyChange,
  onCodexSandboxChange,
  onCodexConfigSourceChange,
  onUnifiedPermissionModeChange,
  includeProjectDocs,
  onIncludeProjectDocsChange,
  onComputerUsePolicyChange,
  onToggleProof,
  onClearEvents,
  promptSuggestion,
  subagentSnapshots = [],
}: {
  surfaceMode?: ChatSurfaceMode;
  sdkSlashCommands?: AgentChatSlashCommand[];
  modelId: string;
  availableModelIds?: string[];
  reasoningEffort: string | null;
  draft: string;
  attachments: AgentChatFileRef[];
  pendingInput: PendingInputRequest | null;
  turnActive: boolean;
  sendOnEnter: boolean;
  busy: boolean;
  sessionProvider?: string;
  claudePermissionMode?: AgentChatClaudePermissionMode;
  codexApprovalPolicy?: AgentChatCodexApprovalPolicy;
  codexSandbox?: AgentChatCodexSandbox;
  codexConfigSource?: AgentChatCodexConfigSource;
  unifiedPermissionMode?: AgentChatUnifiedPermissionMode;
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
  onApproval: (decision: AgentChatApprovalDecision) => void;
  onAddAttachment: (attachment: AgentChatFileRef) => void;
  onRemoveAttachment: (path: string) => void;
  onSearchAttachments: (query: string) => Promise<AgentChatFileRef[]>;
  onExecutionModeChange?: (mode: AgentChatExecutionMode) => void;
  onClaudePermissionModeChange?: (mode: AgentChatClaudePermissionMode) => void;
  onCodexApprovalPolicyChange?: (policy: AgentChatCodexApprovalPolicy) => void;
  onCodexSandboxChange?: (sandbox: AgentChatCodexSandbox) => void;
  onCodexConfigSourceChange?: (source: AgentChatCodexConfigSource) => void;
  onUnifiedPermissionModeChange?: (mode: AgentChatUnifiedPermissionMode) => void;
  includeProjectDocs?: boolean;
  onIncludeProjectDocsChange?: (checked: boolean) => void;
  onComputerUsePolicyChange: (policy: ComputerUsePolicy) => void;
  onToggleProof?: () => void;
  onClearEvents?: () => void;
  promptSuggestion?: string | null;
  subagentSnapshots?: ChatSubagentSnapshot[];
}) {
  const [attachmentPickerOpen, setAttachmentPickerOpen] = useState(false);
  const [attachmentQuery, setAttachmentQuery] = useState("");
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentResults, setAttachmentResults] = useState<AgentChatFileRef[]>([]);
  const [attachmentCursor, setAttachmentCursor] = useState(0);

  const [slashPickerOpen, setSlashPickerOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashCursor, setSlashCursor] = useState(0);

  const [dragActive, setDragActive] = useState(false);
  const [advancedMenuOpen, setAdvancedMenuOpen] = useState(false);
  const [computerUseModalOpen, setComputerUseModalOpen] = useState(false);

  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const advancedMenuRef = useRef<HTMLDivElement | null>(null);
  const advancedButtonRef = useRef<HTMLButtonElement | null>(null);
  const canAttach = !turnActive;

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
    if (!computerUseModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setComputerUseModalOpen(false);
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [computerUseModalOpen]);

  useEffect(() => {
    if (!advancedMenuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (advancedMenuRef.current?.contains(target)) return;
      if (advancedButtonRef.current?.contains(target)) return;
      setAdvancedMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAdvancedMenuOpen(false);
        advancedButtonRef.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [advancedMenuOpen]);

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
    onAddAttachment(attachment);
    setAttachmentPickerOpen(false);
  };

  const addFileAttachments = async (files: FileList | null | undefined) => {
    if (!canAttach || !files?.length) return;
    for (const file of Array.from(files)) {
      const fileWithPath = file as File & { path?: string };
      const hasRealPath = typeof fileWithPath.path === "string" && fileWithPath.path.trim().length > 0;

      if (hasRealPath) {
        // File from filesystem (drag-drop from Finder, native picker)
        const filePath = fileWithPath.path!;
        onAddAttachment({ path: filePath, type: inferAttachmentType(filePath, file.type) });
      } else {
        // Clipboard paste or browser drag — no filesystem path.
        // Read the blob, save to a temp file via IPC, then attach.
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
        } catch {
          // Silently skip files that can't be saved
        }
      }
    }
  };

  const handleSlashSelect = (cmd: SlashCommandEntry) => {
    setSlashPickerOpen(false);
    setSlashQuery("");
    // Local-only commands handled client-side
    if (cmd.command === "/clear" && onClearEvents) { onClearEvents(); onDraftChange(""); return; }
    // SDK and all other commands: set as draft text to be sent to the agent
    const hint = cmd.argumentHint ? ` ` : " ";
    onDraftChange(`${cmd.command}${hint}`);
  };

  const nativeControlsDisabled = permissionModeLocked;
  const showCodexFlagControls = codexConfigSource !== "config-toml";
  const nativeControlPanel = useMemo(() => {
    const renderSelect = <T extends string,>(
      label: string,
      value: T | undefined,
      options: Array<{ value: T; label: string }>,
      onChange: ((value: T) => void) | undefined,
      disabled = false,
    ) => (
      <label className="flex items-center gap-2 rounded-md border border-white/[0.06] bg-[#1a1a22] px-2.5 py-1.5">
        <span className="font-mono text-[9px] uppercase tracking-[0.16em] text-muted-fg/45">{label}</span>
        <select
          value={value}
          disabled={disabled || !onChange}
          onChange={(event) => onChange?.(event.target.value as T)}
          className="min-w-0 bg-transparent font-sans text-[11px] text-fg/82 outline-none disabled:cursor-not-allowed disabled:text-muted-fg/35"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
    );

    if (sessionProvider === "claude") {
      return renderSelect("Claude", claudePermissionMode, CLAUDE_PERMISSION_OPTIONS, onClaudePermissionModeChange, nativeControlsDisabled);
    }

    if (sessionProvider === "codex") {
      return (
        <div className="flex flex-wrap items-center gap-2">
          {renderSelect("Config", codexConfigSource, CODEX_CONFIG_SOURCE_OPTIONS, onCodexConfigSourceChange, nativeControlsDisabled)}
          {renderSelect("Approval", codexApprovalPolicy, CODEX_APPROVAL_OPTIONS, onCodexApprovalPolicyChange, nativeControlsDisabled || !showCodexFlagControls)}
          {renderSelect("Sandbox", codexSandbox, CODEX_SANDBOX_OPTIONS, onCodexSandboxChange, nativeControlsDisabled || !showCodexFlagControls)}
        </div>
      );
    }

    return renderSelect("ADE", unifiedPermissionMode, UNIFIED_PERMISSION_OPTIONS, onUnifiedPermissionModeChange, nativeControlsDisabled);
  }, [
    claudePermissionMode,
    codexApprovalPolicy,
    codexConfigSource,
    codexSandbox,
    nativeControlsDisabled,
    onClaudePermissionModeChange,
    onCodexApprovalPolicyChange,
    onCodexConfigSourceChange,
    onCodexSandboxChange,
    onUnifiedPermissionModeChange,
    sessionProvider,
    showCodexFlagControls,
    unifiedPermissionMode,
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
    if (busy || !modelId) return;
    onSubmit();
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

  return (
    <>
      <ChatComposerShell
      mode={surfaceMode}
      className="m-3 mt-0 rounded-[var(--chat-radius-shell)]"
      pendingBanner={pendingInput ? (
        <div className="px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--chat-radius-pill)] border border-amber-400/20 bg-amber-500/10">
              <Lightning size={11} weight="bold" className="text-amber-300" />
            </span>
            <span className="font-mono text-[9px] font-bold uppercase tracking-widest text-amber-200">
              {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? "Approval" : "Input needed"} · {pendingInput.source}
            </span>
          </div>
          <div className="mb-2 font-mono text-[11px] leading-relaxed text-fg/68">
            {pendingInput.description ?? pendingInput.questions[0]?.question ?? "The agent is waiting for input."}
          </div>
          {pendingInput.kind === "approval" || pendingInput.kind === "permissions" ? (
            <div className="flex items-center gap-1.5">
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-accent/30 bg-accent/12 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/80 transition-colors hover:bg-accent/20" onClick={() => onApproval("accept")}>Accept</button>
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/50 transition-colors hover:bg-border/10" onClick={() => onApproval("accept_for_session")}>Accept all</button>
              <button type="button" className="rounded-[var(--chat-radius-pill)] border border-border/20 px-3 py-1 font-mono text-[9px] font-bold uppercase tracking-wider text-fg/40 transition-colors hover:bg-border/10" onClick={() => onApproval("decline")}>Decline</button>
            </div>
          ) : (
            <div className="font-mono text-[10px] uppercase tracking-[0.14em] text-amber-200/60">
              Open the question modal to answer and continue.
            </div>
          )}
        </div>
      ) : undefined}
      trays={
        attachments.length || subagentSnapshots.length ? (
          <div className="space-y-2 px-1 py-2">
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
                    if (event.key === "ArrowDown") { event.preventDefault(); setAttachmentCursor((v) => Math.min(v + 1, Math.max(attachmentResults.length - 1, 0))); return; }
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
        <div className="space-y-2 px-3 py-2">
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {nativeControlPanel}
            </div>

            <div className="min-w-0 shrink">
              <UnifiedModelSelector
                value={modelId}
                onChange={onModelChange}
                availableModelIds={availableModelIds}
                disabled={modelSelectionLocked}
                showReasoning
                reasoningEffort={reasoningEffort}
                onReasoningEffortChange={onReasoningEffortChange}
              />
            </div>
          </div>

          <div className="flex items-center gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-1">
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                disabled={!canAttach}
                onClick={() => canAttach && setAttachmentPickerOpen((o) => !o)}
                title="Attach files or images (@)"
              >
                @
              </button>
              <button
                type="button"
                className="rounded-md px-1.5 py-1 text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                disabled={!canAttach}
                onClick={openUploadPicker}
                title="Upload file from disk"
              >
                <Paperclip size={12} />
              </button>
              <button
                type="button"
                className="rounded-md px-2 py-1 font-sans text-[10px] text-muted-fg/22 transition-colors hover:bg-white/5 hover:text-muted-fg/55"
                onClick={() => { onDraftChange("/"); setSlashPickerOpen(true); setSlashQuery(""); setSlashCursor(0); textareaRef.current?.focus(); }}
                title="Commands (/)"
              >
                /
              </button>
            </div>

            <div className="ml-auto flex shrink-0 items-center gap-1.5">
              <div className="relative">
                <button
                  ref={advancedButtonRef}
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center gap-1 rounded-md border px-2.5 font-sans text-[10px] font-medium transition-colors",
                    advancedMenuOpen
                      ? "border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)]"
                      : "border-white/[0.06] bg-white/[0.02] text-muted-fg/40 hover:border-white/[0.12] hover:text-fg/68",
                  )}
                  onClick={() => setAdvancedMenuOpen((open) => !open)}
                  title="Open advanced composer settings"
                  aria-expanded={advancedMenuOpen}
                >
                  <span>Advanced</span>
                  <CaretDown size={10} weight="bold" />
                </button>
                {advancedMenuOpen ? (
                  <div ref={advancedMenuRef}>
                    <AdvancedSettingsPopover
                      executionModeOptions={executionModeOptions}
                      executionMode={executionMode ?? null}
                      onExecutionModeChange={onExecutionModeChange}
                      computerUsePolicy={computerUsePolicy}
                      computerUseSnapshot={computerUseSnapshot ?? null}
                      onOpenComputerUseDetails={() => {
                        setAdvancedMenuOpen(false);
                        setComputerUseModalOpen(true);
                      }}
                      proofOpen={proofOpen}
                      proofArtifactCount={proofArtifactCount}
                      onToggleProof={onToggleProof}
                      includeProjectDocs={includeProjectDocs}
                      onIncludeProjectDocsChange={onIncludeProjectDocsChange}
                    />
                  </div>
                ) : null}
              </div>

              {turnActive ? (
                <>
                  {draft.trim().length > 0 && onClearDraft ? (
                    <button
                      type="button"
                      className="inline-flex h-7 items-center justify-center rounded-md border border-white/[0.06] px-2 font-sans text-[10px] text-muted-fg/45 transition-all hover:bg-white/[0.04] hover:text-fg/72"
                      onClick={onClearDraft}
                      title="Clear draft only"
                    >
                      Clear
                    </button>
                  ) : null}
                  {draft.trim().length > 0 ? (
                    <button
                      type="button"
                      className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] transition-all hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_18%,transparent)]"
                      onClick={onSubmit}
                      title="Send steer message"
                    >
                      <PaperPlaneTilt size={11} weight="fill" />
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md border border-red-500/20 bg-red-500/[0.06] text-red-400/70 transition-all hover:border-red-500/35 hover:bg-red-500/12 hover:text-red-400"
                    title="Stop the active turn only (Cmd+.)"
                    onClick={onInterrupt}
                  >
                    <Square size={10} weight="fill" />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className={cn(
                    "inline-flex h-7 items-center justify-center rounded-md border px-3 transition-all",
                    busy || !draft.trim().length || !modelId
                      ? "border-white/[0.04] text-muted-fg/12"
                      : "border-[color:color-mix(in_srgb,var(--chat-accent)_28%,transparent)] bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,transparent)] text-[var(--chat-accent)] hover:bg-[color:color-mix(in_srgb,var(--chat-accent)_20%,transparent)]",
                  )}
                  disabled={busy || !draft.trim().length || !modelId}
                  onClick={onSubmit}
                  title={!modelId ? "Select a model first" : "Send"}
                >
                  <PaperPlaneTilt size={11} weight="fill" />
                  <span className="ml-1 font-sans text-[10px]">Send</span>
                </button>
              )}
            </div>
          </div>
        </div>
      }
    >
      <div
        className="relative"
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {dragActive ? (
          <div className="pointer-events-none absolute inset-0 z-[1] flex items-center justify-center bg-[color:color-mix(in_srgb,var(--chat-accent)_12%,rgba(5,5,8,0.58))] backdrop-blur-sm">
            <div className="rounded-[var(--chat-radius-card)] border border-[color:color-mix(in_srgb,var(--chat-accent)_32%,transparent)] bg-card/92 px-5 py-4 text-center shadow-[var(--chat-composer-shadow)]">
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--chat-accent)]">Drop files to attach</div>
              <div className="mt-1 text-[12px] text-fg/74">Images and files will be added to this turn.</div>
            </div>
          </div>
        ) : null}

        <div className="relative">
          {/* Ghost suggestion overlay */}
          {promptSuggestion && !draft.length && !turnActive ? (
            <div
              className="pointer-events-none absolute inset-0 flex items-start px-4 py-3"
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
            className={cn(
              "min-h-[40px] max-h-[160px] w-full resize-none bg-transparent px-4 py-3 text-[13px] leading-[1.6] text-fg/88 outline-none transition-colors placeholder:text-muted-fg/25",
              dragActive ? "opacity-30" : "",
            )}
            placeholder={turnActive ? "Steer the active turn..." : (promptSuggestion ? "" : (messagePlaceholder ?? "Message the assistant..."))}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
        </div>
      </div>
      </ChatComposerShell>
      <ComputerUseSettingsModal
        open={computerUseModalOpen}
        policy={computerUsePolicy}
        snapshot={computerUseSnapshot ?? null}
        onClose={() => setComputerUseModalOpen(false)}
        onChange={onComputerUsePolicyChange}
        onOpenProof={() => {
          if (!proofOpen) onToggleProof?.();
          setComputerUseModalOpen(false);
        }}
      />
    </>
  );
}
